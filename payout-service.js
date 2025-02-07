const logger = require('../../utils/logger');
const { post } = require('../../utils/http');
const base62 = require('base62-random');
const { yesBankCustomerId,  yesBankCorporateAccountNumber, yesBankDomesticPaymentsBaseUrl, yesBankInitiateDomesticPaymentPath, yesBankPaymentStatusPath, yesBankFundConfirmationPath } = require('../../config/vars');
const https = require('https');
const { phone } = require('phone');

/**
 * A service class for interacting with Yes Bank's payout services.
 * @class
 */
class YesBankPayoutService {

  #clientId;
  #clientSecret;
  #httpUsername;
  #httpPassword;
  #httpsAgent;

  /**
     * Initializes a new instance of the YesBankPayoutService class.
     * This class facilitates interactions with Yes Bank's domestic payments API.
     * @constructor
     *
     * @param {string} clientId - The client ID for authentication.
     * @param {string} clientSecret - The client secret for authentication.
     * @param {string} httpUsername - The HTTP username for making requests.
     * @param {string} httpPassword - The HTTP password for making requests.
     * @param {Buffer} clientKey - The private key for making secure requests (PEM format).
     * @param {Buffer} clientCert - The SSL certificate for making secure requests (PEM format).
     */

  constructor(clientId, clientSecret, httpUsername, httpPassword, clientKey, clientCert) {
    this.baseURL = yesBankDomesticPaymentsBaseUrl;
    this.customerId = yesBankCustomerId;
    this.corporateAccountNumber = yesBankCorporateAccountNumber;
    this.domesticPaymentPath = yesBankInitiateDomesticPaymentPath;
    this.paymentStatusPath = yesBankPaymentStatusPath;
    this.fundConfirmationPath = yesBankFundConfirmationPath;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#httpUsername = httpUsername;
    this.#httpPassword = httpPassword;
    this.#httpsAgent = new https.Agent({
      key: clientKey,
      cert: clientCert
    });

  }

  /**
     * Parses an address object and maps its properties to a standardized format.
     *
     * @param {Object} address - The address object to be parsed.
     *
     * @returns {Object} A parsed address object with standardized properties:
     * @property {string[]} AddressLine - An array of address components in a preferred order.
     * @property {string} StreetName - The street name.
     * @property {string} BuildingNumber - The building number.
     * @property {string} PostCode - The postal code.
     * @property {string} TownName - The town or locality name.
     * @property {string[]} CountySubDivision - An array of subdivision names.
     * @property {string} Country - The country name.
     */

  #parseAddress(address) {
    // const addressMapping = {
    //   country: 'Country',
    //   dist: 'CountySubDivision',
    //   house: 'BuildingNumber',
    //   vtc: 'TownName',
    //   street: 'StreetName',
    //   zip: 'PostCode'
    // };
  
    const parsedAddress = {
      AddressLine: [ address?.house, address?.street, address?.landmark, address?.vtc, address?.dist, address?.subdist, address?.state, address?.country ].filter(value => value && value.length > 1).map(value => value.slice(0, 35))
      // StreetName: '',
      // BuildingNumber: '',
      // PostCode: '',
      // TownName: '',
      // CountySubDivision: [],
      // Country: ''
    };
  
    // for (const key in address) {
    //   if (addressMapping[key]) {
    //     if (key === 'country') {
    //       const countryCode = countries?.getAlpha2Code(address[key], 'en');
    //       parsedAddress[addressMapping[key]] = countryCode || '';
    //     } else {
    //       parsedAddress[addressMapping[key]] = address[key];
    //     }
    //   }
    // }
  
    // Object.keys(parsedAddress).forEach((key) => {
    //   if (!parsedAddress[key] || (Array.isArray(parsedAddress[key]) && parsedAddress[key].length === 0) || (typeof parsedAddress[key] === 'string' && parsedAddress[key].length <= 1)) {
    //     delete parsedAddress[key];
    //   }
    // });
  
    return parsedAddress;
  }

  /**
     * Log an error message along with an error object.
     *
     * @private
     * @param {string} message - The error message.
     * @param {Error} error - The error object.
     */

  #logError = (message, error) => logger.error(message, error);

  /**
     * Log an informational message along with additional information.
     *
     * @private
     * @param {string} message - The informational message.
     * @param {any} info - Additional information to log.
     */

  #logInfo = (message, info) => logger.info(message, info);

  /**
     * Get headers for HTTP requests to Yes Bank's domestic payments service.
     *
     * @private
     * @async
     * @returns {Promise<Object>} A Promise that resolves to the headers for the HTTP request.
     */

  #getHttpHeaders = async () => ({
    'Date': `${new Date().toUTCString()}`,
    'X-IBM-Client-Id': `${this.#clientId}`,
    'X-IBM-Client-Secret': `${this.#clientSecret}`,
    'Authorization': `Basic ${Buffer.from(`${this.#httpUsername}:${this.#httpPassword}`).toString('base64')}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  });

  /**
     * Subtracts the country code from a given phone number if it is valid.
     *
     * @param {string} phoneNum - The input phone number that may contain a country code.
     * @returns {string} - The phone number without the country code if valid, or the original phone number if invalid.
     *
     * @example
     * const result = subtractCountryCode('+11234567890');
     * // Returns '1234567890' if the country code is valid, otherwise returns '+1-123-456-7890'.
     */

  #subtractCountryCode(phoneNum) {
    const p = phone(phoneNum);
    if (p.isValid) {
      const phoneNumber = p.phoneNumber.toString();
      const countryCode = p.countryCode.toString();
      if (phoneNumber.startsWith(countryCode)) {
        const phoneNumberWithoutCode = phoneNumber.slice(countryCode.length);
        return phoneNumberWithoutCode;
      } 
    } 
    return phoneNum;
  }

  /**
     * Create data for initiating a fund confirmation request.
     *
     * @private
     * @returns {Object} Data for fund confirmation request.
     */

  #createFundConfirmationData = () => ({
    Data: {
      DebtorAccount: {
        ConsentId: this.customerId,
        Identification: this.corporateAccountNumber,
        SecondaryIdentification: this.customerId
      }
    }
  });

  /**
     * Create data for checking payment status.
     *
     * @private
     * @param {string} referenceId - The reference ID of the payment.
     * @returns {Object} Data for checking payment status.
     */

  #createPaymentStatusData = (referenceId) => ({
    Data: {
      InstrId: referenceId,
      ConsentId: this.customerId,
      SecondaryIdentification: this.customerId
    }
  });

  /**
     * Create data for initiating a domestic payment.
     *
     * @private
     * @param {Object} params - Parameters for the domestic payment.
     * @param {number} params.amount - The payment amount.
     * @param {string} params.referenceId - The payment reference
     * @param {string} params.transferMode - The transfer mode. ('NEFT', 'A2A', 'RTGS', 'IMPS', 'FT')
     * @param {string} params.contextCode - The context code (optional).('GST', 'REFUND', 'NODAL')
     * @param {Object} params.user - User information.
     * @param {string} params.user.accountNumber - The recipient's account number.
     * @param {string} params.user.accountIfsc - The recipient's IFSC code.
     * @param {string} params.user.name - The recipient's name.
     * @param {string} params.user.email - The recipient's email.
     * @param {string} params.user.phone - The recipient's phone number.
     * @param {Object} params.user.address - The recipient's address.
     * @returns {Object} Data for initiating a domestic payment.
     */

  #createPaymentData = (params) => {
    const { amount, transferMode, user, contextCode, referenceId  } = params;
    // eslint-disable-next-line no-unused-vars
    const { accountNumber, accountIfsc, name, email, phone : phoneNumber, address } = user;

    const endToEndReferenceId = `${base62(8)}`.toUpperCase();

    const data = {
      Data: {
        ConsentId: this.customerId,
        Initiation: {
          InstructionIdentification: referenceId,
          EndToEndIdentification: endToEndReferenceId,
          InstructedAmount: {
            Amount: amount,
            Currency: 'INR'
          },
          DebtorAccount: {
            Identification: this.corporateAccountNumber,
            SecondaryIdentification: this.customerId
          },
          CreditorAccount: {
            SchemeName: accountIfsc,
            Identification: accountNumber,
            Name: name,
            Unstructured: {
              ContactInformation: {
                EmailAddress: email
                // MobileNumber: this.#subtractCountryCode(phoneNumber)
              }
            }
          },
          RemittanceInformation: {
            Unstructured: {
              CreditorReferenceInformation: 'pass' // mandatory
            }
          },
          ClearingSystemIdentification: transferMode
        }
      },
      Risk: {
        ...(contextCode && {
          PaymentContextCode: contextCode
        }),
        DeliveryAddress: this.#parseAddress(address)
      }
    };
    return data;
  };

  /**
     * Validates parameters for initiating a domestic payment.
     *
     * @private
     * @param {Object} params - Parameters for the domestic payment.
     * @param {number} params.amount - The payment amount.
     * @param {string} params.referenceId - The payment reference
     * @param {string} params.transferMode - The transfer mode.
     * @param {string} params.contextCode - The context code (optional).
     * @param {Object} params.user - User information.
     * @param {string} params.user.accountNumber - The recipient's account number.
     * @param {string} params.user.accountIfsc - The recipient's IFSC code.
     * @param {string} params.user.name - The recipient's name.
     * @param {string} params.user.email - The recipient's email.
     * @param {string} params.user.phone - The recipient's phone number.
     * @param {Object} params.user.address - The recipient's address.
     * @returns {string|null} A validation error message if validation fails, or null if validation is successful.
     */

  #validateInitiateDomesticPaymentParams(params) {
    const errors = [];
  
    if (typeof params.amount !== 'number' || isNaN(params.amount)) {
      errors.push('Amount must be a valid number.');
    }
  
    if (typeof params.referenceId !== 'string' || !params.referenceId.trim()) {
      errors.push('Payment reference id is missing.');
    }

    const validTransferModes = ['NEFT', 'A2A', 'RTGS', 'IMPS', 'FT', 'ANY'];
    if (!validTransferModes.includes(params.transferMode)) {
      errors.push('Invalid transfer mode.');
    }
  
    const validContextCodes = ['GST', 'REFUND', 'NODAL'];
    if (params.contextCode && !validContextCodes.includes(params.contextCode)) {
      errors.push('Invalid context code.');
    }
  
    const { user } = params;
    if (!user || typeof user !== 'object') {
      errors.push('User information is missing or invalid.');
    } 
      
    if (typeof user.accountNumber !== 'string' || !user.accountNumber.trim()) {
      errors.push('User account number is required.');
    }
  
    if (typeof user.accountIfsc !== 'string' || !user.accountIfsc.trim()) {
      errors.push('User account IFSC is required.');
    }
  
    if (typeof user.name !== 'string' || !user.name.trim()) {
      errors.push('User name is required.');
    }
  
    if ( typeof user.email !== 'string' ||  !user.email.trim()  ) {
      errors.push('User email is required and must be a valid email address.');
    }
  
    if (typeof user.phone !== 'string' || !user.phone.trim()) {
      errors.push('User phone number is required.');
    }
  
    if (typeof user.address !== 'object') {
      errors.push('User address is required.');
    }
  
    if (errors.length > 0) {
      throw new Error(errors.join(', '));
    }
  }

  /**
   * Exposes private methods for testing purposes.
   * Allows access to private methods within the class for testing.
   */

  exposePrivateMethodsForTesting() {
    this.logError = this.#logError;
    this.logInfo = this.#logInfo;
    this.parseAddress = this.#parseAddress;
    this.getHttpHeaders = this.#getHttpHeaders;
    this.createFundConfirmationData = this.#createFundConfirmationData;
    this.createPaymentStatusData = this.#createPaymentStatusData;
    this.createPaymentData = this.#createPaymentData;
    this.validateInitiateDomesticPaymentParams = this.#validateInitiateDomesticPaymentParams;
  }

  /**
   * Restores private methods to their original state.
   * Removes access to private methods from outside the class.
   */

  unexposePrivateMethodsForTesting() {
    delete this.logError;
    delete this.logInfo;
    delete this.parseAddress;
    delete this.getHttpHeaders;
    delete this.createFundConfirmationData;
    delete this.createPaymentStatusData;
    delete this.createPaymentData;
    delete this.validateInitiateDomesticPaymentParams;
  }

  /**
     * Initiates a domestic payment with Yes Bank.
     * 
     * @async
     * @param {Object} params - Parameters for the domestic payment.
     * @param {number} params.amount - The payment amount.
     * @param {string} params.referenceId - The payment reference
     * @param {string} params.transferMode - The transfer mode. (Valid options: 'NEFT', 'A2A', 'RTGS', 'IMPS', 'FT', 'ANY')
     * @param {string} [params.contextCode] - The context code (optional). (Valid options: 'GST', 'REFUND', 'NODAL')
     * @param {Object} params.user - User information.
     * @param {string} params.user.accountNumber - The recipient's account number.
     * @param {string} params.user.accountIfsc - The recipient's IFSC code.
     * @param {string} params.user.name - The recipient's name.
     * @param {string} params.user.email - The recipient's email.
     * @param {string} params.user.phone - The recipient's phone number.
     * @param {Object} params.user.address - The recipient's address.
     * @returns {Promise} A Promise that resolves to the result of the domestic payment initiation.
     */

  async initiateDomesticPayment(params) {
    try {
      this.#logInfo('API call initiateDomesticPayment', { params });
      this.#validateInitiateDomesticPaymentParams(params);
      const data = this.#createPaymentData(params);
      const response = await post(`${this.baseURL}${this.domesticPaymentPath}`, data, await this.#getHttpHeaders(), this.#httpsAgent);
      return response?.data;
    } catch (error) {
      this.#logError('Error in initiateDomesticPayment', error);
      throw error;
    }
    // ...
  }

  /**
     * Checks the availability of funds with Yes Bank.
     * 
     * @async
     * @returns {Promise} A Promise that resolves to the result of the fund availability check.
     */

  async checkFunds() {
    try {
      logger.info('API call checkFunds');
      const data = this.#createFundConfirmationData();
      const response = await post(`${this.baseURL}${this.fundConfirmationPath}`, data, await this.#getHttpHeaders(), this.#httpsAgent);
      return response?.data;
    } catch (error) {
      this.#logError('Error in checkFunds', error);
      throw error;
    }
    // ...
  }

  /**
     * Checks the payment status with Yes Bank using a reference ID.
     * 
     * @async
     * @param {string} referenceId - The reference ID of the payment.
     * @returns {Promise} A Promise that resolves to the payment status result.
     */

  async checkPaymentStatus(referenceId) {
    logger.info('API call checkPaymentStatus', { referenceId });
    try {
      if (!referenceId) {
        throw new Error('Validation error: referenceId is required');
      }
      const data = this.#createPaymentStatusData(referenceId);
      const response = await post(`${this.baseURL}${this.paymentStatusPath}`, data, await this.#getHttpHeaders(), this.#httpsAgent);
      return response?.data;
    } catch (error) {
      this.#logError('Error in checkPaymentStatus', error);
      throw error;
    }
    // ...
  }
}

module.exports = { YesBankPayoutService };
