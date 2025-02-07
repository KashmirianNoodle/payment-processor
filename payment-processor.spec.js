const { PaymentWorker } = require('./payment-processor');
const { YesBankPayoutService } = require('../yes-bank');
const { getDyanmoDbItem, setDynamoDbItem } = require('../../services/dynamoDb');
const { dynamoDbTransactionTableName, dynamoDbUserTableName } = require('../../config/vars');
const { dispatchNoReplyMail } = require('../../services/zoho');
const { addUserTransactionsHelper } = require('../../lambdas/user');
const logger = require('../../utils/logger');

jest.mock('../../utils/logger');
jest.mock('../../services/dynamoDb');
jest.mock('aws-sdk');
jest.mock('../../services/zoho');
jest.mock('../../lambdas/user', () => ({ addUserTransactionsHelper: jest.fn(() => true) }));

const mockSQSInstance = {
  changeMessageVisibility: jest.fn().mockReturnThis(),
  deleteMessage: jest.fn().mockReturnThis(),
  sendMessage: jest.fn().mockReturnThis(),
  promise: jest.fn()
};

describe('paymentWorker', () => {
  let instance;
  let event;
  let payoutInstance;

  beforeAll(() => {
    event = {
      Records: [
        {
          receiptHandle: 'mockReceiptHandle',
          body: JSON.stringify({
            reference_id: 'mockReferenceId',
            email: 'mockEmail',
            source: 'mockSource',
            amount: 100
          })
        }
      ]
    };

    payoutInstance = new YesBankPayoutService(
      'clientId',
      'clientSecret',
      'httpUsername',
      'httpPassword',
      Buffer.from('clientKey'),
      Buffer.from('clientCert')
    );

    instance = new PaymentWorker(
      'yourQueueUrl',
      mockSQSInstance,
      payoutInstance,
      ['settlementcompleted', 'settlementinprocess'],
      ['failed'],
      Object.freeze({
        PENDING: 'pending',
        SUCCESS: 'success',
        FAILED: 'failed'
      })
    );
  });
  afterAll(() => {
    jest.clearAllMocks();
  });

  describe('processPaymentEvent', () => {
    let checkPaymentStatusMock;
    let isPaymentAlreadyProcessedMock;
    let handlePaymentPassedMock;
    let handlePaymentFailedMock;
    let handlePaymentPendingMock;
    let callbackMock;

    beforeEach(() => {
      checkPaymentStatusMock = jest.spyOn(payoutInstance, 'checkPaymentStatus');
      isPaymentAlreadyProcessedMock = jest.spyOn(instance, 'isPaymentAlreadyProcessed');
      handlePaymentPassedMock = jest.spyOn(instance, 'handlePaymentPassed');
      handlePaymentFailedMock = jest.spyOn(instance, 'handlePaymentFailed');
      handlePaymentPendingMock = jest.spyOn(instance, 'handlePaymentPending');
      callbackMock = jest.fn();
      const mockGetTransaction = jest.spyOn(instance, 'getTransaction');
      mockGetTransaction.mockResolvedValue({});
    });

    afterEach(() => {
      checkPaymentStatusMock.mockRestore();
      isPaymentAlreadyProcessedMock.mockRestore();
      handlePaymentPassedMock.mockRestore();
      handlePaymentFailedMock.mockRestore();
      handlePaymentPendingMock.mockRestore();
      callbackMock.mockRestore();
    });

    it('should not process, if payment is duplicate/ already processed', async () => {
      isPaymentAlreadyProcessedMock.mockResolvedValue(true);
      await instance.processPaymentEvent(event, {}, callbackMock);
      expect(isPaymentAlreadyProcessedMock).toHaveBeenCalled();
      expect(checkPaymentStatusMock).not.toHaveBeenCalled();
      expect(handlePaymentPassedMock).not.toHaveBeenCalled();
      expect(handlePaymentFailedMock).not.toHaveBeenCalled();
      expect(handlePaymentPendingMock).not.toHaveBeenCalled();
      expect(callbackMock).toHaveBeenCalledWith(null, event);
    });

    it('should process a payment record with acceptable status', async () => {
      isPaymentAlreadyProcessedMock.mockResolvedValue(false);
      checkPaymentStatusMock.mockResolvedValue({ Data: { Status: 'settlementcompleted' } });
      await instance.processPaymentEvent(event, {}, callbackMock, 'p');
      expect(isPaymentAlreadyProcessedMock).toHaveBeenCalled();
      expect(checkPaymentStatusMock).toHaveBeenCalled();
      expect(handlePaymentPassedMock).toHaveBeenCalled();
      expect(handlePaymentFailedMock).not.toHaveBeenCalled();
      expect(handlePaymentPendingMock).not.toHaveBeenCalled();
      expect(callbackMock).toHaveBeenCalledWith(null, event);
    });

    it('should process a payment record with unacceptable status', async () => {
      isPaymentAlreadyProcessedMock.mockResolvedValue(false);
      handlePaymentFailedMock.mockResolvedValue({});
      checkPaymentStatusMock.mockResolvedValue({ Data: { Status: 'failed' } });
      const mockGetTransaction = jest.spyOn(instance, 'getTransaction');
      mockGetTransaction.mockResolvedValue({});
      await instance.processPaymentEvent(event, {}, callbackMock);
      expect(isPaymentAlreadyProcessedMock).toHaveBeenCalled();
      expect(checkPaymentStatusMock).toHaveBeenCalled();
      expect(handlePaymentPassedMock).not.toHaveBeenCalled();
      expect(handlePaymentFailedMock).toHaveBeenCalled();
      expect(handlePaymentPendingMock).not.toHaveBeenCalled();
      expect(callbackMock).toHaveBeenCalledWith(null, event);
    });

    it('should process a payment record with pending status', async () => {
      isPaymentAlreadyProcessedMock.mockResolvedValue(false);
      checkPaymentStatusMock.mockResolvedValue({ Data: { Status: 'pending' } });
      const mockGetTransaction = jest.spyOn(instance, 'getTransaction');
      mockGetTransaction.mockResolvedValue({});
      await instance.processPaymentEvent(event, {}, callbackMock);
      expect(isPaymentAlreadyProcessedMock).toHaveBeenCalled();
      expect(checkPaymentStatusMock).toHaveBeenCalled();
      expect(handlePaymentPassedMock).not.toHaveBeenCalled();
      expect(handlePaymentFailedMock).not.toHaveBeenCalled();
      expect(handlePaymentPendingMock).toHaveBeenCalled();
      expect(callbackMock).toHaveBeenCalledWith(null, expect.any(Object));
    });

    it('should handle an error while processing a payment record', async () => {
      isPaymentAlreadyProcessedMock.mockResolvedValue(false);
      checkPaymentStatusMock.mockRejectedValue(new Error('Payment status error'));
      await instance.processPaymentEvent(event, {}, callbackMock);
      expect(isPaymentAlreadyProcessedMock).toHaveBeenCalled();
      expect(checkPaymentStatusMock).toHaveBeenCalled();
      expect(handlePaymentPassedMock).not.toHaveBeenCalled();
      expect(handlePaymentFailedMock).not.toHaveBeenCalled();
      expect(handlePaymentPendingMock).not.toHaveBeenCalled();
      expect(callbackMock).toHaveBeenCalledWith(null, expect.any(Object));
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('isPaymentAlreadyProcessed', () => {
    let getTransactionMock;

    beforeEach(() => {
      getTransactionMock = jest.spyOn(instance, 'getTransaction');
    });

    afterEach(() => {
      getTransactionMock.mockRestore();
    });

    it('should return false if the transaction status is PENDING', async () => {
      getTransactionMock.mockResolvedValue({ status: instance.dbPaymentStatus.PENDING });
      const result = await instance.isPaymentAlreadyProcessed('referenceId', 'source');
      expect(result).toBe(false);
    });

    it('should return true if the transaction status is SUCCESS', async () => {
      getTransactionMock.mockResolvedValue({ status: instance.dbPaymentStatus.SUCCESS });
      const result = await instance.isPaymentAlreadyProcessed('referenceId', 'source');
      expect(result).toBe(true);
    });

    it('should return true if the transaction status is FAILED', async () => {
      getTransactionMock.mockResolvedValue({ status: instance.dbPaymentStatus.FAILED });
      const result = await instance.isPaymentAlreadyProcessed('referenceId', 'source');
      expect(result).toBe(true);
    });

    it('should handle errors', async () => {
      getTransactionMock.mockRejectedValue(new Error('DynamoDB error'));
      await expect(instance.isPaymentAlreadyProcessed('referenceId', 'source')).rejects.toThrow();
    });
  });

  describe('updateTransactionStatus', () => {
    let getTransactionMock;
    let callbackMock;

    beforeEach(() => {
      getTransactionMock = jest.spyOn(instance, 'getTransaction');
      callbackMock = jest.fn();
    });

    afterEach(() => {
      getTransactionMock.mockRestore();
      callbackMock.mockRestore();
    });

    it('should update the transaction status', async () => {
      const referenceId = '123456';
      const source = 'example';
      const status = 'completed';
      const transaction = { referenceId, source, status: 'pending' };
      getTransactionMock.mockResolvedValue(transaction);
      await instance.updateTransactionStatus(referenceId, source, status);
      expect(setDynamoDbItem).toHaveBeenCalledWith(dynamoDbTransactionTableName, transaction);
    });

    it('should handle errors', async () => {
      const referenceId = '123456';
      const source = 'example';
      const status = 'completed';
      getTransactionMock.mockRejectedValue(new Error('Database Error'));
      await expect(instance.updateTransactionStatus(referenceId, source, status)).rejects.toThrow();
    });
  });

  describe('handlePaymentPassed', () => {
    let markPaymentAsProcessedMock;
    let deleteMessageFromQueueMock;
    let notifyUserPaymentPassedMock;

    beforeEach(() => {
      markPaymentAsProcessedMock = jest.spyOn(instance, 'markPaymentAsProcessed');
      deleteMessageFromQueueMock = jest.spyOn(instance, 'deleteMessageFromQueue');
      notifyUserPaymentPassedMock = jest.spyOn(instance, 'notifyUserPaymentPassed');
    });

    afterEach(() => {
      markPaymentAsProcessedMock.mockRestore();
      deleteMessageFromQueueMock.mockRestore();
      notifyUserPaymentPassedMock.mockRestore();
    });

    it('should handle payment passed', async () => {
      const email = 'user@example.com';
      const referenceId = '123456';
      const source = 'example';
      const receiptHandle = 'abc123';

      markPaymentAsProcessedMock.mockResolvedValue();
      deleteMessageFromQueueMock.mockResolvedValue();
      notifyUserPaymentPassedMock.mockResolvedValue();

      await instance.handlePaymentPassed(email, referenceId, source, receiptHandle);
      expect(markPaymentAsProcessedMock).toHaveBeenCalledWith(referenceId, source);
      expect(deleteMessageFromQueueMock).toHaveBeenCalledWith(receiptHandle);
      expect(notifyUserPaymentPassedMock).toHaveBeenCalledWith(email);
    });

    it('should handle errors', async () => {
      const email = 'user@example.com';
      const referenceId = '123456';
      const source = 'example';
      const receiptHandle = 'abc123';
      markPaymentAsProcessedMock.mockRejectedValue(new Error('Processing error'));
      await expect(instance.handlePaymentPassed(email, referenceId, source, receiptHandle)).rejects.toThrow();
    });
  });

  describe('handlePaymentFailed', () => {
    let markPaymentAsFailedMock;
    let deleteMessageFromQueueMock;
    let notifyUserPaymentFailedMock;
    let handleUserRefundMock;

    beforeEach(() => {
      markPaymentAsFailedMock = jest.spyOn(instance, 'markPaymentAsFailed');
      deleteMessageFromQueueMock = jest.spyOn(instance, 'deleteMessageFromQueue');
      notifyUserPaymentFailedMock = jest.spyOn(instance, 'notifyUserPaymentFailed');
      handleUserRefundMock = jest.spyOn(instance, 'handleUserRefund');
    });

    afterEach(() => {
      markPaymentAsFailedMock.mockRestore();
      deleteMessageFromQueueMock.mockRestore();
      notifyUserPaymentFailedMock.mockRestore();
      handleUserRefundMock.mockRestore();
    });

    it('should handle payment failed', async () => {
      const email = 'user@example.com';
      const referenceId = '123456';
      const source = 'example';
      const receiptHandle = 'abc123';
      const amount = '10';

      markPaymentAsFailedMock.mockResolvedValue();
      deleteMessageFromQueueMock.mockResolvedValue();
      notifyUserPaymentFailedMock.mockResolvedValue();
      handleUserRefundMock.mockResolvedValue({});

      await instance.handlePaymentFailed(email, referenceId, source, amount, receiptHandle);
      expect(markPaymentAsFailedMock).toHaveBeenCalledWith(referenceId, source);
      expect(deleteMessageFromQueueMock).toHaveBeenCalledWith(receiptHandle);
      expect(notifyUserPaymentFailedMock).toHaveBeenCalledWith(email);
      expect(handleUserRefundMock).toHaveBeenCalledWith(email, amount, referenceId);
    });

    it('should handle errors', async () => {
      const email = 'user@example.com';
      const referenceId = '123456';
      const source = 'example';
      const receiptHandle = 'abc123';
      markPaymentAsFailedMock.mockRejectedValue(new Error('Processing error'));
      await expect(instance.handlePaymentPassed(email, referenceId, source, receiptHandle)).rejects.toThrow();
    });
  });

  describe('handlePaymentPending', () => {
    let handlePaymentFailedMock;
    let deleteMessageFromQueueMock;
    let handleUserRefundMock;
    let sendRetryMessageMock;

    beforeEach(() => {
      deleteMessageFromQueueMock = jest.spyOn(instance, 'deleteMessageFromQueue');
      handleUserRefundMock = jest.spyOn(instance, 'handleUserRefund');
      sendRetryMessageMock = jest.spyOn(instance, 'sendRetryMessage');
      handlePaymentFailedMock = jest.spyOn(instance, 'handlePaymentFailed');
    });

    afterEach(() => {
      handlePaymentFailedMock.mockRestore();
      deleteMessageFromQueueMock.mockRestore();
      handleUserRefundMock.mockRestore();
      sendRetryMessageMock.mockRestore();
    });

    it('should send a retry message for valid retry count', async () => {
      const attr = { retryCount: { S: '2' } };
      const transaction = { email: 'test@example.com', reference_id: '12345', source: 'Credit Card', amount: 100 };
      const receiptHandle = 'mockReceiptHandle';
      await instance.handlePaymentPending(attr, transaction, receiptHandle);
      expect(sendRetryMessageMock).toHaveBeenCalledWith(transaction, 3);
      expect(deleteMessageFromQueueMock).toHaveBeenCalledWith(receiptHandle);
    });

    it('should handle payment failure when retry count exceeds the maximum', async () => {
      const attr = { retryCount: { S: '3' } };
      const transaction = { email: 'test@example.com', reference_id: '12345', source: 'Credit Card', amount: 100 };
      const receiptHandle = 'mockReceiptHandle';
      handlePaymentFailedMock.mockReturnValue({});
      await instance.handlePaymentPending(attr, transaction, receiptHandle);
      expect(handlePaymentFailedMock).toHaveBeenCalledWith(
        transaction.email,
        transaction.reference_id,
        transaction.source,
        transaction.amount,
        receiptHandle
      );
    });
  });

  describe('markPaymentAsProcessed', () => {
    let updateTransactionStatusMock;
    beforeEach(() => {
      updateTransactionStatusMock = jest.spyOn(instance, 'updateTransactionStatus');
    });

    afterEach(() => {
      updateTransactionStatusMock.mockRestore();
    });

    it('should mark payment as succeded', async () => {
      const referenceId = '123456';
      const source = 'example';
      updateTransactionStatusMock.mockResolvedValue();
      await instance.markPaymentAsProcessed(referenceId, source);
      expect(updateTransactionStatusMock).toHaveBeenCalledWith(
        referenceId,
        source,
        instance.dbPaymentStatus['SUCCESS']
      );
    });
  });

  describe('markPaymentAsFailed', () => {
    let updateTransactionStatusMock;

    beforeEach(() => {
      updateTransactionStatusMock = jest.spyOn(instance, 'updateTransactionStatus');
    });

    afterEach(() => {
      updateTransactionStatusMock.mockRestore();
    });

    it('should mark payment as failed', async () => {
      const referenceId = '123456';
      const source = 'example';
      updateTransactionStatusMock.mockResolvedValue();
      await instance.markPaymentAsFailed(referenceId, source);
      expect(updateTransactionStatusMock).toHaveBeenCalledWith(referenceId, source, instance.dbPaymentStatus['FAILED']);
    });
  });

  describe('markPaymentAsPending', () => {
    it('should call change message visiblity', async () => {
      const receiptHandle = 'abc123';
      await instance.markPaymentAsPending(receiptHandle);
      expect(mockSQSInstance.changeMessageVisibility).toHaveBeenCalledWith({
        QueueUrl: 'yourQueueUrl',
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 3600
      });
    });
  });

  describe('sendRetryMessage', () => {
    const transaction = {
      reference_id: 'mockReferenceId',
      email: 'mockEmail',
      source: 'mockSource',
      amount: 100
    };
    const retryCount = 2;

    it('should send a retry message successfully', async () => {
      const sendMessageMock = jest.fn().mockReturnValue({ MessageId: '123456' });
      const promiseMock = jest.fn();

      instance.sqs.sendMessage = sendMessageMock;
      instance.sqs.sendMessage.mockReturnValue({ promise: promiseMock });

      await instance.sendRetryMessage(transaction, retryCount);

      expect(sendMessageMock).toHaveBeenCalledWith({
        QueueUrl: instance.queueUrl,
        MessageBody: JSON.stringify(transaction),
        MessageAttributes: {
          RetryCount: {
            DataType: 'String',
            StringValue: retryCount.toString()
          }
        },
        MessageGroupId: transaction.reference_id
      });

      expect(promiseMock).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('deleteMessageFromQueue', () => {
    it('should delete a message from the queue', async () => {
      const receiptHandle = 'abc123';
      await instance.deleteMessageFromQueue(receiptHandle);
      expect(mockSQSInstance.deleteMessage).toHaveBeenCalledWith({
        QueueUrl: instance.queueUrl,
        ReceiptHandle: receiptHandle
      });
    });
  });

  describe('handleUserRefund', () => {
    it('should handle user refund successfully', async () => {
      const email = 'user@example.com';
      const amount = 50;
      const referenceId = 'mockReferenceId';
      const userData = { user_id: email, wallet_amount: 100, updated_at: new Date().toISOString() };
      getDyanmoDbItem.mockResolvedValue({ Item: userData });
      setDynamoDbItem.mockResolvedValue({});
      addUserTransactionsHelper.mockResolvedValue({});
      await instance.handleUserRefund(email, amount, referenceId);

      expect(getDyanmoDbItem).toHaveBeenCalledWith(dynamoDbUserTableName, { user_id: email });
      expect(setDynamoDbItem).toHaveBeenCalledWith(dynamoDbUserTableName, {
        ...userData,
        wallet_amount: 150,
        updated_at: expect.any(String)
      });
      expect(addUserTransactionsHelper).toHaveBeenCalledWith(email, expect.any(Object));
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('notifyUserPaymentPassed', () => {
    it('should notify the user about a successful payment', async () => {
      const email = 'user@example.com';
      dispatchNoReplyMail.mockResolvedValue({});
      await instance.notifyUserPaymentPassed(email);
      expect(dispatchNoReplyMail).toHaveBeenCalledWith(email, null, expect.any(String), expect.any(String));
    });
  });

  describe('notifyUserPaymentFailed', () => {
    it('should notify the user about a failed payment', async () => {
      const email = 'user@example.com';
      dispatchNoReplyMail.mockResolvedValue({});
      await instance.notifyUserPaymentFailed(email);
      expect(dispatchNoReplyMail).toHaveBeenCalledWith(email, null, expect.any(String), expect.any(String));
    });
  });
});
