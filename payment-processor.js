const AWS = require('aws-sdk');
const logger = require('../../utils/logger');
const { dynamoDbTransactionTableName, dynamoDbUserTableName, yesBankPaymentStatusMaxRetryCount } = require('../../config/vars');
const { dispatchNoReplyMail } = require('../../services/zoho');
const { getDyanmoDbItem, setDynamoDbItem, queryDynamoDb } = require('../../services/dynamoDb');
const { parseAmount } = require('../../utils/common');
const { addUserTransactionsHelper } = require('../../lambdas/user');

/**
 * PaymentProcessor class for publishing payment events to an SQS queue.
 */
class PaymentProcessor {
  /**
   * Constructor for the PaymentProcessor class.
   * @param {string} queueUrl - The URL of the SQS queue to publish payment events to.
   */

  constructor(queueUrl, sqsInstance = new AWS.SQS()) {
    this.sqs = sqsInstance;
    this.queueUrl = queueUrl;
  }
  
  /**
   * @async
   * Publishes a payment event to the SQS queue.
   * @param {object} transaction - The payment transaction to publish.
   */

  async publishPaymentEvent(transaction) {
    try {
      const params = {
        MessageBody: JSON.stringify(transaction),
        QueueUrl: this.queueUrl,
        MessageGroupId: `${transaction.reference_id}`
      };
      logger.info('Sending Payment event to SQS:', { params });
      await this.sqs.sendMessage(params).promise();
      logger.info('Payment published successfully.');
    } catch (error) {
      logger.error('Error publishing payment:', { error });
    }
  }
}

/**
 * PaymentWorker class for processing payment events.
 */
class PaymentWorker extends PaymentProcessor {

  /**
   * Constructor for the PaymentWorker class.
   * @param {string} queueUrl - The URL of the SQS queue to process payment events from.
   * @param {object} sqsInstance - The SQS instance to interact with sqs (optional).
   * @param {object} payoutClient - The payout client for checking payment status.
   * @param {string[]} acceptablePaymentStatuses - An array of acceptable payment statuses.
   * @param {string[]} unacceptablePaymentStatuses - An array of unacceptable payment statuses.
   * @param {object} dbPaymentStatuses - An object representing payment statuses used in the database.
   */

  constructor(queueUrl, sqsInstance = new AWS.SQS(), payoutClient, acceptablePaymentStatuses, unacceptablePaymentStatuses, dbPaymentStatuses) {
    super(queueUrl, sqsInstance);
    this.payoutClient = payoutClient;
    this.acceptablePaymentStatuses = acceptablePaymentStatuses;
    this.unacceptablePaymentStatuses = unacceptablePaymentStatuses,
    this.dbPaymentStatus = dbPaymentStatuses;
  }

  /**
   * Processes payment events from an SQS queue.
   * @param {object} event - The SQS event containing payment records.
   * @param {object} _context - The AWS Lambda context object.
   * @param {function} callback - The callback function to signal successful completion or Error.
   */

  async processPaymentEvent(event, _context, callback) {
    logger.info('payment event received', { event });
    const { Records } = event;

    for (const record of Records) {
      const { receiptHandle, body } = record;
      try {
        logger.info('Processing payment Record', { record });
  
        const transaction = JSON.parse(body);
        const { reference_id: referenceId, email, source, amount } = transaction;
  
        // Check if the payment status is already updated
        const isProcessed = await this.isPaymentAlreadyProcessed(referenceId, source);
        if (isProcessed) {
          logger.info('Payment record already processed. Ignoring.', { record });
          continue;
        }
  
        // api call to find status of payment
        const paymentStatusResponse = await this.payoutClient.checkPaymentStatus(referenceId);
        logger.info('Payment status api response', { paymentStatusResponse });

        const paymentStatus = paymentStatusResponse?.Data?.Status?.toLowerCase();
  
        if (this.acceptablePaymentStatuses.includes(paymentStatus)) {
          await this.handlePaymentPassed(email, referenceId, source, receiptHandle);
          logger.info('Payment Succeeded', { record });

        } else if (this.unacceptablePaymentStatuses.includes(paymentStatus)) {
          await this.handlePaymentFailed(email, referenceId, source, amount, receiptHandle);
          logger.error('Payment Failed', { transaction, paymentStatusResponse });

        } else {
          await this.handlePaymentPending(record?.messageAttributes, transaction, receiptHandle);
          logger.info('Payment pending, sent for retry', { record });
          
        }
        logger.info('Success in processing payment record', { event });
      } catch (error) {
        logger.error('Error processing payment record', { record, error });
        callback(new Error('Something Went Wrong'), event);
      }
    }
    callback(null, event);
  }

  /**
   * Retrieves a transaction from the DynamoDB table based on reference ID and source.
   *
   * @param {string} referenceId - The reference ID of the transaction to retrieve.
   * @param {string} source - The source of the transaction to retrieve.
   * @returns {Promise<object>} A Promise that resolves to the retrieved transaction object.
   * @throws {Error} Throws an error if the transaction is not found in the database.
   */

  async getTransaction(referenceId, source) {
    const query = {
      TableName: dynamoDbTransactionTableName,
      KeyConditionExpression: '#kn0 = :kv0 AND #kn1 = :kv1',
      IndexName: 'reference_id-source-index',
      ExpressionAttributeNames: { '#kn0': 'reference_id', '#kn1': 'source' },
      ExpressionAttributeValues: { ':kv0': referenceId, ':kv1': source }
    };
  
    const reference = await queryDynamoDb(query);
    const transaction = reference?.Items?.shift();
    if (!transaction) {
      throw new Error('Could not find transaction');
    }
    return transaction;
  }

  /**
   * @async
   * Checks if a payment event has already been processed.
   * @param {string} referenceId - The reference ID of the payment event.
   * @param {string} source - The source of the payment event.
   * @returns {Promise<boolean>} True if the payment event is already processed, false otherwise (false when status is not pending).
   */

  async isPaymentAlreadyProcessed(referenceId, source) {
    // Check if the payment event is already processed in DynamoDB
    const transaction = await this.getTransaction(referenceId, source);
    return !(transaction.status === this.dbPaymentStatus['PENDING']);
  }

  /**
   * Updates the status of a transaction in DynamoDB.
   * @param {string} referenceId - The reference ID of the transaction.
   * @param {string} source - The source of the transaction.
   * @param {string} status - The new status to set. Must be one of: "pending" or "failed"
   */

  async updateTransactionStatus(referenceId, source, status) {
    const transaction = await this.getTransaction(referenceId, source);
    transaction.status = status;
    await setDynamoDbItem(dynamoDbTransactionTableName, transaction);
    logger.info('updated transanction status', { referenceId, source, status });
  }
    
  /**
   * Handles a payment that has passed successfully (marks as processed, deltes from the queue, notifies user).
   * @param {string} email - The email of the user.
   * @param {string} referenceId - The reference ID of the payment event.
   * @param {string} source - The source of the payment event.
   * @param {string} receiptHandle - The receipt handle of the SQS message.
   */
  
  async handlePaymentPassed(email, referenceId, source, receiptHandle) {
    await this.markPaymentAsProcessed(referenceId, source);
    await this.deleteMessageFromQueue(receiptHandle);
    await this.notifyUserPaymentPassed(email);
  }

  /**
   * Handles a payment that has failed (marks as failed, deletes from the queue, notifies user, refunds user). 
   * @param {string} email - The email of the user.
   * @param {string} referenceId - The reference ID of the payment event.
   * @param {string} source - The source of the payment event.
   * @param {number} amount - The amount of the payment.
   * @param {string} receiptHandle - The receipt handle of the SQS message.
   */

  async handlePaymentFailed(email, referenceId, source, amount, receiptHandle) {
    await this.markPaymentAsFailed(referenceId, source);
    await this.deleteMessageFromQueue(receiptHandle);
    await this.notifyUserPaymentFailed(email);
    await this.handleUserRefund(email, amount, referenceId);
  }

  /**
   * Marks a payment as processed in the database.
   * @param {string} referenceId - The reference ID of the payment event.
   * @param {string} source - The source of the payment event.
   */

  async markPaymentAsProcessed(referenceId, source) {
    await this.updateTransactionStatus(referenceId, source, this.dbPaymentStatus['SUCCESS']);
  }

  /**
   * Marks a payment as failed in the database.
   * @param {string} referenceId - The reference ID of the payment event.
   * @param {string} source - The source of the payment event.
   */

  async markPaymentAsFailed(referenceId, source) {
    await this.updateTransactionStatus(referenceId, source, this.dbPaymentStatus['FAILED']);
  }

  /**
   * Marks a payment as pending in the queue, changes message visibility so payment message can be picked again after a while .
   * @param {string} receiptHandle - The receipt handle of the SQS message.
   */

  async markPaymentAsPending(receiptHandle) {
    await this.sqs.changeMessageVisibility({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 3600 }).promise();
  }

  /**
   * Handles a pending payment event by retrying or marking as failed.
   * @param {object} attr - The message attributes that include the retry count number.
   * @param {object} transaction - The payment transaction.
   * @param {string} receiptHandle - The receipt handle of the SQS message.
   */

  async handlePaymentPending(attr, transaction, receiptHandle) {
    const retryCount = Number(attr?.RetryCount?.stringValue) || 1;

    // if (!retryCount) {
    //   await this.markPaymentAsPending(receiptHandle);
    //   return;
    // }

    if (retryCount < yesBankPaymentStatusMaxRetryCount) {
      // Increment retryCount and send a new message for retry   (update retry count in db?)
      const newRetryCount = retryCount + 1;
      await this.sendRetryMessage(transaction, newRetryCount);
      await this.deleteMessageFromQueue(receiptHandle);
    } else {
      await this.handlePaymentFailed( transaction.email, transaction.reference_id, transaction.source, transaction.amount, receiptHandle);
    }
  }

  /**
   * Sends a retry message for a payment event.
   * @param {object} transaction - The payment transaction to retry.
   * @param {number} retryCount - The current retry count.
   */

  async sendRetryMessage(transaction, retryCount) {
    try {
      const messageBody = JSON.stringify(transaction);

      const messageAttributes = {
        RetryCount: {
          DataType: 'String',
          StringValue: retryCount.toString()
        }
      };

      const params = {
        QueueUrl: this.queueUrl,
        MessageBody: messageBody,
        MessageAttributes: messageAttributes,
        MessageGroupId: `${transaction.reference_id}`
      };

      await this.sqs.sendMessage(params).promise();
    } catch (error) {
      logger.error('Error sending retry message:', { error });
      throw error;
    }
  }

  /**
   * Deletes a message from the queue.
   * @param {string} receiptHandle - The receipt handle of the SQS message to delete.
   */ 

  async deleteMessageFromQueue(receiptHandle) {
    const params = {
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle
    };

    try {
      await this.sqs.deleteMessage(params).promise();
      logger.info('Successfully deleted message from queue');
    } catch (error) {
      logger.error('Error deleting message from queue:', { error });
      throw error;
    }
  }

  /**
   * Handles a user refund operation.
   * @param {string} email - The email of the user.
   * @param {number} amount - The amount to refund.
   * @param {string} referenceId - The reference Id for transaction to generate reverse transaction
   */

  async handleUserRefund(email, amount, referenceId) {
    const userEntity = await getDyanmoDbItem(dynamoDbUserTableName, { user_id: email });
    const userData = userEntity.Item;
    const updatedUserData = {
      ...userData,
      wallet_amount: parseAmount(userData.wallet_amount + amount),
      updated_at: new Date().toISOString()
    };
    const reverseTransactionData = {
      payment_method: 'system',
      amount: amount,
      reference_id: referenceId,
      payment_time: new Date().toISOString(),
      activity_code: 'ACWR',
      source: 'Growpital',
      message: 'Amount Reversed',
      payment_type: 'CREDIT'
    };
    await addUserTransactionsHelper(email, reverseTransactionData);
    await setDynamoDbItem(dynamoDbUserTableName, updatedUserData);
    logger.info('Success in handleUserRefund, generated reverse transaction', { email, amount });
  }

  /**
   * Notifies the user about a successful payment.
   * @param {string} email - The email of the user.
   */

  async notifyUserPaymentPassed(email) {
    // requires change for better notification
    const subject = 'payment confirmation';
    const message = 'Your payment was successfull!';
    await dispatchNoReplyMail(email, null, subject, message);
  }

  /**
   * Notifies the user about a failed payment.
   * @param {string} email - The email of the user.
   */

  async notifyUserPaymentFailed(email) {
    // requires change for better notification
    const subject = 'payment error';
    const message = 'We apologize, but we were unable to process your payment at the moment. Please be patient, and we will initiate a refund for you shortly.';
    await dispatchNoReplyMail(email, null, subject, message);
  }
}

module.exports = { PaymentProcessor, PaymentWorker };
