const logger = require('../../utils/logger');
const { queryDynamoDb } = require('../../services/dynamoDb');
const { dynamoDbUserTableName,  dynamoDbTransactionTableName,  yesBankeCollectHttpPassword,  yesBankeCollectHttpUsername } = require('../../config/vars');
const { getSecretCredentials } = require('../../services/secretManager');
const { processPayment } = require('../../lambdas/auto-collect-webhook/auto-collect');
const { parseAmount }= require('../../utils/common');
const crypto = require('crypto'); 

/**
 * Class representing a handler for ECollect webhook operations.
 */
class ECollectService {

  /**
     * Validate response codes.
     * @readonly
     * @enum {number}
     */

  static validateResponse = {
    pass: 200,
    reject: 200,
    pending: 200,
    unauthorized: 401,
    internalServerError: 500,
    badRequest: 400
  };

  /**
     * Notify result response codes.
     * @readonly
     * @enum {number}
     */

  static notifyResult = {
    ok: 200,
    retry: 200,
    unauthorized: 401,
    internalServerError: 500,
    badRequest: 400
  };

  /**
     * The maximum number of retries allowed when generating a virtual account number.
     * If the maximum number of retries is reached, an error will be thrown.
     *
     * @readonly
     * @type {number}
     * @default 3
     *
     */

  static MAX_RETRIES = 3;

  /**
     * Verifies an HTTP token.
     *
     * @param {string} token - The HTTP token to verify.
     * @returns {Promise<boolean>} - Returns true if the token is valid, false otherwise.
     */

  static verifyHttpToken = async (token) => {
    const secretData = await getSecretCredentials();
    const generatedtoken = `Basic ${Buffer.from(`${secretData[yesBankeCollectHttpUsername]}:${secretData[yesBankeCollectHttpPassword]}`).toString('base64')}`;
    return token === generatedtoken;
  };

  /**
     * Checks for a duplicate entry in the DynamoDB.
     *
     * @param {string} referenceId - The reference ID to check.
     * @returns {Promise<boolean>} - Returns false if no duplicate entry is found, true otherwise.
     */

  static checkDuplicateEntry = async (body) => {
    const referenceId = body.transfer_type === 'NEFT' ? `${body.transfer_unique_no}${body.rmtr_account_ifsc}`: `${body.transfer_unique_no}`;
    const query = {
      TableName: dynamoDbTransactionTableName,
      KeyConditionExpression: '#kn0 = :kv0 AND #kn1 = :kv1',
      IndexName: 'reference_id-source-index',
      ExpressionAttributeNames: {  '#kn0': 'reference_id', '#kn1': 'source' },
      ExpressionAttributeValues: { ':kv0': referenceId, ':kv1': 'YESBANK' }
    };
    const reference = await queryDynamoDb(query);
    if (reference?.Items?.length) {
      return true;
    }
    return false;
  };

  /**
     * Retrieves an email from a virtual account.
     *
     * @param {string} virtualAccount - The virtual account number.
     * @returns {Promise<string|boolean>} - Returns the email associated with the virtual account if found, false otherwise.
     */

  static getEmailFromVirtualAccount = async (virtualAccount) => {
    const query = {
      TableName: dynamoDbUserTableName,
      KeyConditionExpression: '#kn0 = :kv0',
      IndexName: 'virtual_account_number_yesbank-index',
      ExpressionAttributeNames: { '#kn0': 'virtual_account_number_yesbank' },
      ExpressionAttributeValues: { ':kv0': virtualAccount }
    };
    const response = await queryDynamoDb(query);
    if (response?.Items?.length) {
      return response?.Items?.[0]?.user_id;
    }
    return false;
  };

  /**
     * Generates a transaction and adds money to the account.
     *
     * @param {string} email - The user's email.
     * @param {Object} body - The notification body.
     */

  /* eslint-disable camelcase */
  static generateTransactionAndAddMoney = async (email, body) => {
    const { transfer_amt, transfer_unique_no, transfer_timestamp, rmtr_account_ifsc, transfer_type, ...rest } = body;
    const transaction = {
      email,
      amount: parseAmount(transfer_amt),
      referenceId: transfer_type === 'NEFT' ? `${transfer_unique_no}${rmtr_account_ifsc}`: `${transfer_unique_no}`,
      paymentTime: transfer_timestamp,
      source: 'YESBANK',
      ...rest
    };
    await processPayment(transaction);
  };
    /* eslint-enable camelcase */

  /**
     * Generates a response object.
     *
     * @param {string} responseKey - The key for the response object.
     * @param {string} decision - The decision for the response.
     * @param {string} rejectReason - The reason for rejection (optional).
     * @param {string} creditAccountNumber - The credit account number (optional).
     * @returns {Object} - Returns a response object.
     */

  static generateResponse = (responseKey, decision, rejectReason, creditAccountNumber) => {

    const validDecisionsByResponseKey = {
      validateResponse: ECollectService.validateResponse,
      notifyResult: ECollectService.notifyResult
    };
    
    const validDecisions = validDecisionsByResponseKey[responseKey] || {};

    const statusCode = validDecisions[decision] || (() => {
      throw new Error('Status code not found'); 
    })();
    const responseDecision = decision in validDecisions ? decision : (() => {
      throw new Error('Decision not found'); 
    })();    

    const response = {
      [responseKey]: {
        [responseKey === 'validateResponse' ? 'decision' : 'result']: responseDecision,
        reject_reason: responseDecision === 'reject' ? (rejectReason || 'Missing reject reason') : undefined,
        credit_account_no: creditAccountNumber || undefined
      }
    };

    return {
      statusCode,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'content-type': 'application/json'
      },
      body: JSON.stringify(response)
    };
  };

  /**
   * Parses a JSON string and returns the resulting object.
   *
   * @param {string} body - The JSON string to parse.
   * @returns {?Object} The parsed JSON object, or `null` if parsing fails.
   * @static
   */

  static parseBody(body) {
    try {
      return JSON.parse(body);
    } catch (err) {
      return null;
    }
  }

  /**
    * Generates a random 16-digit virtual account number prefixed with "GROWPI".
    * @returns {Promise<string>} A 16-digit virtual account number.
    */

  static async generateVirtualAccountNumber(retries = 0) {  
    if (retries >= ECollectService.MAX_RETRIES) {
      throw new Error('Max retries reached. Unable to generate a unique virtual account.');
    }
    // Generate a random 10-digit number
    const randomDigits = crypto.randomBytes(5).readUInt32BE(0) % 10000000000;

    // Concatenate with the prefix "GROWPI" to create a 16-digit virtual account
    const virtualAccount = `GROWPI${String(randomDigits).padStart(10, '0')}`;
    const email = await ECollectService.getEmailFromVirtualAccount(virtualAccount);
    if (email) {
      // Retry if the virtual account is already associated with an email
      return await ECollectService.generateVirtualAccountNumber(retries + 1);
    }
    return virtualAccount;
  }

  /**
   * Receives and validates the incoming webhook event.
   *
   * @param {Object} event - The incoming webhook event.
   * @returns {Promise<ResponseObject>} - Returns a response object.
   *
   * @typedef {Object} ResponseObject
   * @property {number} statusCode - The HTTP status code.
   * @property {Object} headers - The HTTP headers.
   * @property {validateResponse} body - The JSON response body.
   *
   * @typedef {Object} validateResponse
   * @property {string} decision - The decision value.
   * @property {string} [reject_reason] - The reason if the decision is "reject".
   */

  static async validate(event) {
    try {
      logger.info('webhook event in validateWebhookListener', { event });

      const body = ECollectService.parseBody(event.body);
      if (!body) {
        logger.error('Failure in validateWebhookListener, invalid body');
        return ECollectService.generateResponse('validateResponse', 'badRequest', 'invalid request body');
      }

      const isTokenValid = await ECollectService.verifyHttpToken(event.headers['authorization'] || event.headers['Authorization']);
      if (!isTokenValid) {
        logger.info('Failure in validateWebhookListener, unauthorized', { body });
        return ECollectService.generateResponse('validateResponse', 'unauthorized', 'invalid token');
      }

      const email = await ECollectService.getEmailFromVirtualAccount(body.validate.bene_account_no);
      if (!email) {
        logger.info('Failure in validateWebhookListener, user not found', { email, body });
        return ECollectService.generateResponse('validateResponse', 'reject', 'customer does not exist');
      }

      const isDuplicate = await ECollectService.checkDuplicateEntry(body.validate);
      if (isDuplicate) {
        logger.info('Duplicate request in validateWebhookListener', { email, body });
        return ECollectService.generateResponse('validateResponse', 'pass', 'duplicate request');
      }

      logger.info('Success in validateWebhookListener', { email, body });
      return ECollectService.generateResponse('validateResponse', 'pass');

    } catch (error) {
      logger.error('Error in validateWebhookListener', { error });
      return ECollectService.generateResponse('validateResponse', 'internalServerError', 'something went wrong');
    }
  }

  /**
   * Receives and processes the event based on the incoming webhook event.
   *
   * @param {Object} event - The incoming webhook event.
   * @returns {Promise<ResponseObject>} - Returns a response object.
   *
   * @typedef {Object} ResponseObject
   * @property {number} statusCode - The HTTP status code.
   * @property {Object} headers - The HTTP headers.
   * @property {notifyResult} body - The JSON response body.
   *
   * @typedef {Object} notifyResult
   * @property {string} result - The decision value.
   */

  static async notify(event) {
    try {
      logger.info('webhook event in notifyWebhookListener', { event });

      const body = ECollectService.parseBody(event.body);
      if (!body) {
        logger.error('Failure in notifyWebhookListener, invalid body');
        return ECollectService.generateResponse('notifyResult', 'badRequest');
      }

      const isTokenValid = await ECollectService.verifyHttpToken(event.headers['authorization'] || event.headers['Authorization']);
      if (!isTokenValid) {
        logger.info('Failure in notifyWebhookListener, unauthorized', { body });
        return ECollectService.generateResponse('notifyResult', 'unauthorized');
      }

      if (body.notify.status === 'RETURNED') {
        logger.info('Funds Returned in notifyWebhookListener', { body });
        return ECollectService.generateResponse('notifyResult', 'ok');
      }

      const email = await ECollectService.getEmailFromVirtualAccount(body.notify.bene_account_no);
      if (!email) {
        logger.info('Failure in notifyWebhookListener, user not found', { body });
        return ECollectService.generateResponse('notifyResult', 'retry');
      }

      const isDuplicate = await ECollectService.checkDuplicateEntry(body.notify);
      if (isDuplicate) {
        logger.info('Duplicate request in notifyWebhookListener', { email, body });
        return ECollectService.generateResponse('notifyResult', 'ok');
      }

      if (body.notify.status === 'CREDITED') {
        await ECollectService.generateTransactionAndAddMoney(email, body.notify);
        logger.info('Success in notifyWebhookListener', { email, body });
      }
      
      if (body.notify.status !== 'RETURNED' && body.notify.status !== 'CREDITED') {
        logger.error('Failure in notifyWebhookListener', { email, body });
      }
      
      return ECollectService.generateResponse('notifyResult', 'ok');
    } catch (error) {
      logger.error('Error in notifyWebhookListener', { error });
      return ECollectService.generateResponse('notifyResult', 'internalServerError');
    }
  }
}

module.exports = { ECollectService };
