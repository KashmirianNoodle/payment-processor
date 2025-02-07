const { ECollectService } = require('./e-collect'); // Update the path as needed
const { queryDynamoDb } = require('../../services/dynamoDb'); // Import any other dependencies needed for mocking
const { getSecretCredentials } = require('../../services/secretManager');
const { processPayment } = require('../../lambdas/auto-collect-webhook/auto-collect'); // Mocking any other dependencies used in your methods
const { parseAmount } = require('../../utils/common');
const logger = require('../../utils/logger');

// Mocking the dependencies and functions that are used in ECollectService
jest.mock('../../services/dynamoDb');
jest.mock('../../services/secretManager');
jest.mock('../../utils/logger');
jest.mock('../../utils/common', () => ({ parseAmount: jest.fn() }));
jest.mock('../../lambdas/auto-collect-webhook/auto-collect', () => ({ processPayment: jest.fn(() => true) }));

describe('ECollectService', () => {
  // Mocking the necessary functions before each test
  beforeEach(() => {
    queryDynamoDb.mockClear();
    getSecretCredentials.mockClear();
    processPayment.mockClear();
  });

  describe('verifyHttpToken', () => {
    it('should return true for valid token', async () => {
      // Mocking the getSecretCredentials function to return valid credentials
      const username = 'validUsername';
      const password = 'validPassword';
      getSecretCredentials.mockResolvedValueOnce({
        yes_bank_ecollect_http_username_dev: username,
        yes_bank_ecollect_http_password_dev: password
      });
      const token = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      const result = await ECollectService.verifyHttpToken(token);
      expect(result).toBe(true);
    });

    it('should return false for invalid token', async () => {
      // Mocking the getSecretCredentials function to return valid credentials
      getSecretCredentials.mockResolvedValueOnce({
        yes_bank_ecollect_http_username_dev: 'validUsername',
        yes_bank_ecollect_http_password_dev: 'validPassword'
      });
      const token = 'InvalidToken'; // Invalid token
      const result = await ECollectService.verifyHttpToken(token);
      expect(result).toBe(false);
    });
  });

  describe('checkDuplicateEntry', () => {
    it('should return true for a duplicate entry', async () => {
    // Mocking the queryDynamoDb function to return some data (simulating a duplicate entry)
      queryDynamoDb.mockResolvedValueOnce({ Items: [{ someData: 'data' }] });
      const body = {
        transfer_type: 'NEFT',
        transfer_unique_no: '12345',
        rmtr_account_ifsc: 'ABC123'
      };
      const result = await ECollectService.checkDuplicateEntry(body);
      expect(result).toBe(true);
    });

    it('should return false for no duplicate entry', async () => {
    // Mocking the queryDynamoDb function to return no data (no duplicate entry)
      queryDynamoDb.mockResolvedValueOnce({ Items: [] });
      const body = {
        transfer_type: 'NEFT',
        transfer_unique_no: '12345',
        rmtr_account_ifsc: 'ABC123'
      };
      const result = await ECollectService.checkDuplicateEntry(body);
      expect(result).toBe(false);
    });
  });

  describe('getEmailFromVirtualAccount', () => {
    it('should return email if virtual account exists', async () => {
    // Mocking the queryDynamoDb function to return some data (simulating an existing virtual account)
      queryDynamoDb.mockResolvedValueOnce({ Items: [{ user_id: 'testuser@example.com', virtual_account_number_yesbank: 'GROWPI123456' }] });
      const virtualAccount = 'GROWPI123456'; // Existing virtual account
      const result = await ECollectService.getEmailFromVirtualAccount(virtualAccount);
      expect(result).toBe('testuser@example.com');
    });

    it('should return false if virtual account does not exist', async () => {
    // Mocking the queryDynamoDb function to return no data (virtual account does not exist)
      queryDynamoDb.mockResolvedValueOnce({ Items: [] });
      const virtualAccount = 'NonExistingAccount'; // Non-existing virtual account
      const result = await ECollectService.getEmailFromVirtualAccount(virtualAccount);

      expect(result).toBe(false);
    });
  });
  
  describe('generateTransactionAndAddMoney', () => {
    it('should call processPayment with the correct arguments', async () => {
      // Mocking dependencies to simulate a successful scenario
      parseAmount.mockReturnValueOnce(100); // Mocking parsed amount 
      const email = 'testuser@example.com';
      const body = {
        transfer_amt: '100',
        transfer_unique_no: '123456',
        transfer_timestamp: '2023-10-05T10:00:00Z',
        rmtr_account_ifsc: 'IFSC123',
        transfer_type: 'NEFT',
        unknown_key: 'unknown_value'
      };
      await ECollectService.generateTransactionAndAddMoney(email, body, 'p');
      // Verify that processPayment was called with the correct arguments
      expect(processPayment).toBeCalledTimes(1);
      expect(processPayment).toHaveBeenCalledWith({
        email,
        amount: 100, // Mocked parsed amount
        referenceId: '123456IFSC123', // Mocked referenceId based on body data
        paymentTime: '2023-10-05T10:00:00Z', // Mocked paymentTime based on body data
        source: 'YESBANK',
        unknown_key: 'unknown_value'
      });
    });
  });

  describe('generateResponse', () => {
    it('should generate a valid response for validateResponse with "pass"', () => {
      const responseKey = 'validateResponse';
      const decision = 'pass';
      const result = ECollectService.generateResponse(responseKey, decision);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body).toEqual(
        JSON.stringify({
          validateResponse: {
            decision: 'pass'
          }
        })
      );
    });

    it('should generate a valid response for notifyResult with "retry"', () => {
      const responseKey = 'notifyResult';
      const decision = 'retry';
      const result = ECollectService.generateResponse(responseKey, decision);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body).toEqual(
        JSON.stringify({
          notifyResult: {
            result: 'retry'
          }
        })
      );
    });

    it('should generate a valid response with reject_reason and credit_account_no', () => {
      const responseKey = 'validateResponse';
      const decision = 'reject';
      const rejectReason = 'Invalid data';
      const creditAccountNumber = '1234567890';
      const result = ECollectService.generateResponse(responseKey, decision, rejectReason, creditAccountNumber);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.body).toEqual(
        JSON.stringify({
          validateResponse: {
            decision: 'reject',
            reject_reason: 'Invalid data',
            credit_account_no: '1234567890'
          }
        })
      );
    });

    it('should throw an error for an invalid responseKey', () => {
      const responseKey = 'invalidKey';
      const decision = 'pass';
      expect(() => ECollectService.generateResponse(responseKey, decision)).toThrow('Status code not found');
    });
  });

  describe('validate', () => {
    // Mocking the dependencies and functions used in the validate method
    let verifyHttpTokenMock;
    let getEmailFromVirtualAccountMock;
    let checkDuplicateEntryMock;
    let infoMock;
    let errorMock;
    
    const event = {
      body: JSON.stringify({
        validate: {
          customer_code: 'GROWPI',
          bene_account_no: 'GROWPI56789',
          bene_account_ifsc: 'YESB0CMSNOC',
          bene_full_name: 'ABCD',
          transfer_type: 'NEFT',
          transfer_unique_no: 'SBIN89028424345669200',
          transfer_timestamp: '2023-09-27 11:04:15',
          transfer_ccy: 'INR',
          transfer_amt: 50.11,
          rmtr_account_no: '2541109900110050',
          rmtr_account_ifsc: 'IBKL0NEFT01',
          rmtr_account_type: '10',
          rmtr_full_name: 'Jaya',
          rmtr_address: 'YES BANK DOMBIVLI ',
          rmtr_to_bene_note: ' ATTN NREAC INB DEPOSIT INVESTMENT null',
          attempt_no: 4
        }
      }),
      headers: {
        authorization: 'ValidToken'
      }
    };

    beforeEach(() => {
      // Create and spy on mocks for each function before each test
      verifyHttpTokenMock = jest.spyOn(ECollectService, 'verifyHttpToken');
      getEmailFromVirtualAccountMock = jest.spyOn(ECollectService, 'getEmailFromVirtualAccount');
      checkDuplicateEntryMock = jest.spyOn(ECollectService, 'checkDuplicateEntry');
      infoMock = jest.spyOn(logger, 'info');
      errorMock = jest.spyOn(logger, 'error');
    });
    
    afterEach(() => {
      // Restore the original functions after each test
      verifyHttpTokenMock.mockRestore();
      getEmailFromVirtualAccountMock.mockRestore();
      checkDuplicateEntryMock.mockRestore();
      infoMock.mockRestore();
      errorMock.mockRestore();
    });

    it('should return a valid response for a successful validation', async () => {
      // Mocking the functions to simulate a successful validation
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      const result = await ECollectService.validate(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });

    it('should return a "unauthorized" response for an invalid token', async () => {
    // Mocking the verifyHttpToken function to return false (invalid token)
      verifyHttpTokenMock.mockResolvedValueOnce(false);
      const result = await ECollectService.validate(event);
      expect(result.statusCode).toBe(401);
      expect(infoMock).toHaveBeenCalled();
    });

    it('should return a "reject" response for a user not found', async () => {
    // Mocking the functions to simulate a user not found scenario
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce(false);
      const result = await ECollectService.validate(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });

    it('should return a "pass" response for a duplicate request', async () => {
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(true);
      const result = await ECollectService.validate(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });

    it('should return a "badRequest" response for an invalid request body', async () => {
    // Mocking the functions to simulate an invalid request body (SyntaxError)
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      // Simulate a SyntaxError by passing an invalid JSON string
      const mockedEvent = { ...event };
      mockedEvent.body = 'Invalid JSON';
      const result = await ECollectService.validate(mockedEvent);
      expect(result.statusCode).toBe(400);
      expect(errorMock).toHaveBeenCalled();
    });

    it('should return an "internalServerError" response for an unknown error', async () => {
    // Mocking the functions to simulate an unknown error
      verifyHttpTokenMock.mockRejectedValueOnce(new Error('Unknown Error'));
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      const result = await ECollectService.validate(event);
      expect(result.statusCode).toBe(500);
      expect(errorMock).toHaveBeenCalledWith('Error in validateWebhookListener', { error: expect.any(Error) });
    });
  });

  describe('notify', () => {
    // Mocking the dependencies and functions used in the notify method
    let verifyHttpTokenMock;
    let getEmailFromVirtualAccountMock;
    let checkDuplicateEntryMock;
    let generateTransactionAndAddMoneyMock;
    let infoMock;
    let errorMock;
    const event = {
      body: JSON.stringify({
        notify: {
          customer_code: 'GROWPI',
          bene_account_no: 'GROWPI125',
          bene_account_ifsc: 'YESB0CMSNOC',
          bene_full_name: 'ABCD',
          transfer_type: 'NEFT',
          transfer_unique_no: 'SBIN890424345669787',
          transfer_timestamp: '2023-10-03 16:11:06',
          transfer_ccy: 'TRANSFER_CCY',
          transfer_amt: 75.4,
          rmtr_account_no: '2541109900110050',
          rmtr_account_ifsc: 'IBKL0NEFT01',
          rmtr_account_type: '10',
          rmtr_full_name: 'Chaitu',
          rmtr_to_bene_note: ' ATTN NREAC INB DEPOSIT INVESTMENT null',
          attempt_no: 1,
          status: 'CREDITED',
          credit_acct_no: '000380200000292',
          credited_at: ''
        }
      }),
      headers: {
        authorization: 'ValidToken'
      }
    };
  
    beforeEach(() => {
      // Create and spy on mocks for each function before each test
      verifyHttpTokenMock = jest.spyOn(ECollectService, 'verifyHttpToken');
      getEmailFromVirtualAccountMock = jest.spyOn(ECollectService, 'getEmailFromVirtualAccount');
      checkDuplicateEntryMock = jest.spyOn(ECollectService, 'checkDuplicateEntry');
      generateTransactionAndAddMoneyMock = jest.spyOn(ECollectService, 'generateTransactionAndAddMoney');
      infoMock = jest.spyOn(logger, 'info');
      errorMock = jest.spyOn(logger, 'error');
    });
      
    afterEach(() => {
      // Restore the original functions after each test
      verifyHttpTokenMock.mockRestore();
      getEmailFromVirtualAccountMock.mockRestore();
      checkDuplicateEntryMock.mockRestore();
      generateTransactionAndAddMoneyMock.mockRestore();
      infoMock.mockRestore();
      errorMock.mockRestore();
    });

    it('should return a valid response for a successful notification', async () => {
    // Mocking the functions to simulate a successful notification
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });
  
    it('should return a "unauthorized" response for an invalid token', async () => {
    // Mocking the verifyHttpToken function to return false (invalid token)
      verifyHttpTokenMock.mockResolvedValueOnce(false);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(401);
      expect(infoMock).toHaveBeenCalled();
    });
  
    it('should return an "ok" response for funds returned', async () => {
    // Modify the event to simulate "RETURNED" status
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      const mockedEvent = { ...event };
      mockedEvent.body = JSON.stringify({
        notify: {
          bene_account_no: 'GROWPI123456',
          status: 'RETURNED'
        }
      });
      const result = await ECollectService.notify(mockedEvent);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });
  
    it('should return a "retry" response for a user not found', async () => {
    // Mocking the functions to simulate a user not found scenario
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce(false);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });
  
    it('should return an "ok" response for a duplicate request', async () => {
    // Mocking the functions to simulate a duplicate request scenario
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(true);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(200);
      expect(logger.info).toHaveBeenCalled();
    });
  
    it('should return an "ok" response for funds credited and call processPayment', async () => {
    // Mocking the functions to simulate funds credited scenario
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
      expect(ECollectService.generateTransactionAndAddMoney).toHaveBeenCalledWith('testuser@example.com',  JSON.parse(event.body).notify );
    });
  
    it('should return an "ok" response for unknown status and log failure', async () => {
    // Modifying the event to simulate an unknown status
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      const mockedEvent = { ...event };
      mockedEvent.body = JSON.stringify({
        notify: {
          bene_account_no: 'GROWPI123456',
          status: 'UNKNOWN_STATUS'
        }
      });
      const result = await ECollectService.notify(mockedEvent);
      expect(result.statusCode).toBe(200);
      expect(infoMock).toHaveBeenCalled();
    });
  
    it('should return a "badRequest" response for an invalid request body', async () => {
    // Mocking the functions to simulate an invalid request body (SyntaxError)
      verifyHttpTokenMock.mockResolvedValueOnce(true);
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      // Simulate a SyntaxError by passing an invalid JSON string
      const mockedEvent = { ...event };
      mockedEvent.body = 'Invalid JSON';
      const result = await ECollectService.notify(mockedEvent);
      expect(result.statusCode).toBe(400);
      expect(errorMock).toHaveBeenCalled();
    });
  
    it('should return an "internalServerError" response for an unknown error', async () => {
    // Mocking the functions to simulate an unknown error
      verifyHttpTokenMock.mockRejectedValueOnce(new Error('Unknown Error'));
      getEmailFromVirtualAccountMock.mockResolvedValueOnce('testuser@example.com');
      checkDuplicateEntryMock.mockResolvedValueOnce(false);
      const result = await ECollectService.notify(event);
      expect(result.statusCode).toBe(500);
      expect(errorMock).toHaveBeenCalledWith('Error in notifyWebhookListener', { error: expect.any(Error) });
    });
  });

});
