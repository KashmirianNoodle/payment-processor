const { post } = require('../../utils/http');
const { YesBankPayoutService } = require('./payout-service');

// Mocking the dependencies and functions that are used in ECollectService
jest.mock('../../utils/logger');
jest.mock('../../utils/http/http.util', () => ({ post: jest.fn(() => true) }));

describe('YesBankPayoutService', () => {
  let instance;

  beforeAll(() => {
    instance = new YesBankPayoutService(
      'clientId',
      'clientSecret',
      'httpUsername',
      'httpPassword',
      Buffer.from('clientKey'),
      Buffer.from('clientCert')
    );
    instance.exposePrivateMethodsForTesting(); // Expose private methods for testing
  });

  afterAll(() => {
    instance.unexposePrivateMethodsForTesting(); // Unexpose private methods after testing
  });

  describe('Private Methods', () => {
    describe('parseAddress', () => {
      it('should parse an address object correctly', () => {
        const address = {
          country: 'India',
          dist: 'Pune',
          house: 'Shivasmi apartment, Flat no. 201',
          landmark: 'Near satynarayan park',
          loc: 'Wagholi',
          po: 'Vagholi',
          state: 'Maharashtra',
          street: 'Awhalwadi road',
          vtc: 'Wagholi',
          zip: '412207'
        };

        const parsedAddress = instance.parseAddress(address);

        expect(parsedAddress).toEqual({
          AddressLine: [
            'Shivasmi apartment, Flat no. 201',
            'Awhalwadi road',
            'Near satynarayan park',
            'Wagholi',
            'Wagholi',
            'Pune',
            'Maharashtra',
            'India'
          ],
          StreetName: 'Awhalwadi road',
          BuildingNumber: 'Shivasmi apartment, Flat no. 201',
          PostCode: '412207',
          TownName: 'Wagholi',
          CountySubDivision: 'Pune',
          Country: 'IN'
        });
      });
    });

    describe('Logging', () => {
      let infoMock;
      let errorMock;

      beforeEach(() => {
        // Create and spy on mocks for each function before each test
        infoMock = jest.spyOn(instance, 'logInfo');
        errorMock = jest.spyOn(instance, 'logError');
      });

      afterEach(() => {
        // Restore the original functions after each test
        infoMock.mockRestore();
        errorMock.mockRestore();
      });

      it('should log info', () => {
        instance.logInfo('Test', 'info');
        expect(infoMock).toHaveBeenCalledWith('Test', 'info');
      });
      it('should log error', () => {
        instance.logError('Test Error', new Error('Test Error'));
        expect(errorMock).toHaveBeenCalledWith('Test Error', new Error('Test Error'));
      });
    });

    describe('getHttpHeaders', () => {
      it('should generate proper Http Headers', async () => {
        const headers = await instance.getHttpHeaders();
        const expectedHeaders = {
          Date: expect.any(String), // Check if it's a string (date format)
          'X-IBM-Client-Id': 'clientId',
          'X-IBM-Client-Secret': 'clientSecret',
          Authorization: `Basic ${Buffer.from(`${'httpUsername'}:${'httpPassword'}`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        };

        // Check if the actual headers match the expected headers
        expect(headers).toEqual(expectedHeaders);
      });
    });

    describe('Data creation ', () => {
      let createFundConfirmationDataMock;
      let createPaymentStatusDataMock;
      let createPaymentDataMock;

      beforeEach(() => {
        // Initialize payment service instance with required properties
        createFundConfirmationDataMock = jest.spyOn(instance, 'createFundConfirmationData');
        createPaymentStatusDataMock = jest.spyOn(instance, 'createPaymentStatusData');
        createPaymentDataMock = jest.spyOn(instance, 'createPaymentData');
        instance.customerId = 'your-customer-id';
        instance.corporateAccountNumber = 'your-account-number';
      });
      afterEach(() => {
        createFundConfirmationDataMock.mockRestore();
        createPaymentStatusDataMock.mockRestore();
        createPaymentDataMock.mockRestore();
      });

      it('should create fund confirmation data with the correct structure', () => {
        // Act
        const fundConfirmationData = instance.createFundConfirmationData();
        // Assert
        expect(createFundConfirmationDataMock).toHaveBeenCalledTimes(1);
        expect(fundConfirmationData).toEqual({
          Data: {
            DebtorAccount: {
              ConsentId: instance.customerId,
              Identification: instance.corporateAccountNumber,
              SecondaryIdentification: instance.customerId
            }
          }
        });
      });
      it('should create payment status data with the correct structure', () => {
        // Arrange
        const referenceId = 'your-reference-id';
        // Act
        const paymentStatusData = instance.createPaymentStatusData(referenceId);
        // Assert
        expect(createPaymentStatusDataMock).toHaveBeenCalledTimes(1);
        expect(paymentStatusData).toEqual({
          Data: {
            InstrId: referenceId,
            ConsentId: instance.customerId,
            SecondaryIdentification: instance.customerId
          }
        });
      });
      it('should create payment data with the correct structure', () => {
        // Arrange
        const params = {
          amount: 1000,
          transferMode: 'IMPS',
          user: {
            accountNumber: 'user-account-number',
            accountIfsc: 'user-account-ifsc',
            name: 'user-name',
            email: 'user-email@example.com',
            phone: 'user-phone-number',
            address: 'user-address'
          },
          referenceId: 'reference-id'
        };

        // Act
        const paymentData = instance.createPaymentData(params);

        // Assert
        expect(createPaymentDataMock).toHaveBeenCalledTimes(1);
        expect(paymentData).toEqual({
          Data: {
            ConsentId: instance.customerId,
            Initiation: {
              InstructionIdentification: params.referenceId,
              EndToEndIdentification: expect.any(String),
              InstructedAmount: {
                Amount: params.amount,
                Currency: 'INR'
              },
              DebtorAccount: {
                Identification: instance.corporateAccountNumber,
                SecondaryIdentification: instance.customerId
              },
              CreditorAccount: {
                SchemeName: params.user.accountIfsc,
                Identification: params.user.accountNumber,
                Name: params.user.name,
                Unstructured: {
                  ContactInformation: {
                    EmailAddress: params.user.email,
                    MobileNumber: params.user.phone
                  }
                }
              },
              RemittanceInformation: {
                Unstructured: {
                  CreditorReferenceInformation: 'pass'
                }
              },
              ClearingSystemIdentification: params.transferMode
            }
          },
          Risk: {
            DeliveryAddress: expect.any(Object)
          }
        });
      });
    });
  });

  describe('initiateDomesticPayment', () => {
    let validateInitiateDomesticPaymentParamsMock;
    let createPaymentDataMock;

    beforeEach(() => {
      validateInitiateDomesticPaymentParamsMock = jest.spyOn(instance, 'validateInitiateDomesticPaymentParams');
      createPaymentDataMock = jest.spyOn(instance, 'createPaymentData');
    });

    afterEach(() => {
      // Restore the original functions after each test
      validateInitiateDomesticPaymentParamsMock.mockRestore();
      createPaymentDataMock.mockRestore();
      post.mockRestore();
    });

    it('should initiate a domestic payment successfully', async () => {
      // Arrange
      const params = {
        amount: 100,
        referenceId: 'REF123',
        transferMode: 'NEFT',
        user: {
          accountNumber: '1234567890',
          accountIfsc: 'ABCD1234',
          name: 'John Doe',
          email: 'john@example.com',
          phone: '1234567890',
          address: {
            street: '123 Main St',
            town: 'San Francisco',
            state: 'California',
            country: 'United States'
          }
        }
      };
      // Mock the HTTP client's post method to return the expected response
      const expectedResponse = { data: 'Payment initiated successfully' };
      post.mockResolvedValue(expectedResponse);
      // Act
      const result = await instance.initiateDomesticPayment(params);
      // Assert
      expect(result).toEqual(expectedResponse.data);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.any(Object), expect.any(Object));
    });

    it('should handle errors during initiation', async () => {
      // Arrange
      const params = {
        amount: 100,
        referenceId: 'REF123',
        transferMode: 'NEFT',
        user: {
          accountNumber: '1234567890',
          accountIfsc: 'ABCD1234',
          name: 'John Doe',
          email: 'john@example.com',
          phone: '1234567890',
          address: {
            street: '123 Main St',
            town: 'San Francisco',
            state: 'California',
            country: 'United States'
          }
        }
      };
      // Mock the HTTP client's post method to throw an error
      const expectedError = new Error('Payment initiation failed');
      post.mockRejectedValue(expectedError);
      // Act and Assert
      await expect(instance.initiateDomesticPayment(params)).rejects.toThrow(expectedError);
    });
  });

  describe('checkFunds', () => {
    afterEach(() => {
      post.mockRestore();
    });
    it('should check funds successfully', async () => {
      // Arrange
      const expectedResponse = { data: 'Funds available' };
      // Mock the HTTP client's post method to return the expected response
      post.mockResolvedValue(expectedResponse);
      // Act
      const result = await instance.checkFunds();
      // Assert
      expect(result).toEqual(expectedResponse.data);
      expect(post).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.any(Object), expect.any(Object));
    });

    it('should handle errors when checking funds', async () => {
      // Arrange
      const expectedError = new Error('Funds check failed');
      // Mock the HTTP client's post method to throw an error
      post.mockRejectedValue(expectedError);
      // Act and Assert
      await expect(instance.checkFunds()).rejects.toThrow(expectedError);
    });
  });

  describe('checkPaymentStatus', () => {
    it('should check payment status successfully', async () => {
      // Arrange
      const referenceId = 'your-reference-id'; // Replace with a valid reference ID
      const expectedResponse = { data: 'Payment status: success' };
      // Mock the HTTP client's post method to return the expected response
      post.mockResolvedValue(expectedResponse);
      // Act
      const result = await instance.checkPaymentStatus(referenceId);
      // Assert
      expect(result).toEqual(expectedResponse.data);
      expect(post).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.any(Object), expect.any(Object));
    });

    it('should handle validation error when referenceId is missing', async () => {
      // Arrange
      const referenceId = undefined;
      const expectedError = new Error('Validation error: referenceId is required');
      // Act and Assert
      await expect(instance.checkPaymentStatus(referenceId)).rejects.toThrow(expectedError);
    });

    it('should handle errors when checking payment status', async () => {
      // Arrange
      const referenceId = 'your-reference-id';
      const expectedError = new Error('Payment status check failed');
      // Mock the HTTP client's post method to throw an error
      post.mockRejectedValue(expectedError);
      // Act and Assert
      await expect(instance.checkPaymentStatus(referenceId)).rejects.toThrow(expectedError);
    });
  });
});
