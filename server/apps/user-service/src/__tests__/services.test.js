/**
 * Unit Tests for user-service - Service Layer
 * Tests: loginCustomer, registerCustomer, verifyCustomer, ownerLogin, adminApproveOwner, resetPassword
 */

const bcrypt = require('../utils/bcrypt');
const jwt = require('../utils/jwt');
const { generateOTP } = require('../utils/otp');
const { sendOtpEmail } = require('../utils/emailQueue');
const { withTransaction } = require('../db');
const { publishSocketEvent } = require('../utils/rabbitmq');
const roleRepository = require('../repositories/role.repository');
const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/userToken.repository');

// Mock all external dependencies
jest.mock('../utils/bcrypt');
jest.mock('../utils/jwt');
jest.mock('../utils/otp');
jest.mock('../utils/emailQueue');
jest.mock('../db');
jest.mock('../utils/rabbitmq');
jest.mock('../repositories/role.repository');
jest.mock('../repositories/user.repository');
jest.mock('../repositories/userToken.repository');

// Import services after mocking
const customerService = require('../services/customer.service');
const restaurantService = require('../services/restaurant.service');

describe('Customer Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default withTransaction mock - executes callback immediately
    withTransaction.mockImplementation(async (callback) => {
      const mockClient = {};
      return callback(mockClient);
    });
  });

  // =========================================================================
  // TEST #1: loginCustomer() - HAPPY PATH
  // =========================================================================
  describe('loginCustomer() - Happy Path', () => {
    it('should authenticate customer and return JWT token when credentials are valid', async () => {
      // GIVEN - A verified customer with valid credentials exists
      const mockUser = {
        id: 'user-123',
        email: 'customer@test.com',
        first_name: 'John',
        last_name: 'Doe',
        phone: '0123456789',
        email_verified: true,
      };
      const mockRole = { id: 'role-customer', code: 'customer' };
      const mockCredential = { password_hash: 'hashed_password_123' };
      const mockProfile = { loyalty_points: 100 };
      const mockToken = 'jwt_token_abc123';

      // userRepository.findByEmail.mockResolvedValue(mockUser);
      // userRepository.getUserRoleCodes.mockResolvedValue(['customer']);
      // roleRepository.getRoleByCode.mockResolvedValue(mockRole);
      // userRepository.getCredential.mockResolvedValue(mockCredential);
      // bcrypt.compare.mockResolvedValue(true);
      // jwt.sign.mockReturnValue(mockToken);
      // userRepository.getCustomerProfile.mockResolvedValue(mockProfile);

      // WHEN - Customer attempts to login with correct email and password
      const result = await customerService.loginCustomer({
        email: 'Customer@Test.com',
        password: 'correct_password',
      });

      // THEN - Should return success message, token, and user data
      expect(result.message).toBe('Login successful');
      expect(result.token).toBe(mockToken);
      expect(result.user.id).toBe('user-123');
      expect(result.user.email).toBe('customer@test.com');
      expect(result.user.emailVerified).toBe(true);
      expect(result.user.profile).toEqual(mockProfile);

      // Verify correct flow
      expect(userRepository.findByEmail).toHaveBeenCalledWith('customer@test.com');
      expect(bcrypt.compare).toHaveBeenCalledWith('correct_password', 'hashed_password_123');
      expect(jwt.sign).toHaveBeenCalledWith(
        { userId: 'user-123', role: 'customer' },
        { expiresIn: '1h' }
      );
    });
  });

  // =========================================================================
  // TEST #2: loginCustomer() - ERROR CASES
  // =========================================================================
  describe('loginCustomer() - Error Cases', () => {
    it('should reject with 401 when email is missing', async () => {
      // GIVEN - No email provided
      // WHEN - Attempting login without email
      // THEN - Should throw error with status 401
      await expect(
        customerService.loginCustomer({ email: null, password: 'password' })
      ).rejects.toMatchObject({
        message: 'Email and password are required',
        status: 401,
      });
    });

    it('should reject with 401 when password is missing', async () => {
      // GIVEN - No password provided
      // WHEN - Attempting login without password
      // THEN - Should throw error with status 401
      await expect(
        customerService.loginCustomer({ email: 'test@test.com', password: '' })
      ).rejects.toMatchObject({
        message: 'Email and password are required',
        status: 401,
      });
    });

    it('should reject with 401 when user does not exist', async () => {
      // GIVEN - User does not exist in database
      userRepository.findByEmail.mockResolvedValue(null);

      // WHEN - Attempting login with non-existent email
      // THEN - Should throw "Invalid credentials" (not reveal user doesn't exist)
      await expect(
        customerService.loginCustomer({ email: 'unknown@test.com', password: 'password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });

    it('should reject with 401 when user is not a customer role', async () => {
      // GIVEN - User exists but has no customer role
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1', email_verified: true });
      userRepository.getUserRoleCodes.mockResolvedValue(['owner']);

      // WHEN - Attempting customer login with non-customer account
      // THEN - Should throw "Invalid credentials"
      await expect(
        customerService.loginCustomer({ email: 'owner@test.com', password: 'password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });

    it('should reject with 403 when customer account is not verified', async () => {
      // GIVEN - Customer exists but email is not verified
      userRepository.findByEmail.mockResolvedValue({
        id: 'user-1',
        email: 'unverified@test.com',
        email_verified: false,
      });
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);

      // WHEN - Attempting login with unverified account
      // THEN - Should throw "Account not verified" with 403
      await expect(
        customerService.loginCustomer({ email: 'unverified@test.com', password: 'password' })
      ).rejects.toMatchObject({
        message: 'Account not verified',
        status: 403,
      });
    });

    it('should reject with 401 when password is incorrect', async () => {
      // GIVEN - User exists, verified, but wrong password
      userRepository.findByEmail.mockResolvedValue({
        id: 'user-1',
        email_verified: true,
      });
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-customer' });
      userRepository.getCredential.mockResolvedValue({ password_hash: 'correct_hash' });
      bcrypt.compare.mockResolvedValue(false);

      // WHEN - Attempting login with wrong password
      // THEN - Should throw "Invalid credentials"
      await expect(
        customerService.loginCustomer({ email: 'test@test.com', password: 'wrong_password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });
  });

  // =========================================================================
  // TEST #3: registerCustomer() - HAPPY PATH
  // =========================================================================
  describe('registerCustomer() - Happy Path', () => {
    it('should register new customer with hashed password, OTP generation, and email sent', async () => {
      // GIVEN - New customer data with valid email and password
      const mockRole = { id: 'role-customer', code: 'customer' };
      const mockUser = {
        id: 'new-user-123',
        email: 'newcustomer@test.com',
        first_name: 'Jane',
        last_name: 'Smith',
      };
      const mockOtp = '123456';
      const mockPasswordHash = 'bcrypt_hashed_password';

      roleRepository.ensureGlobalRoles.mockResolvedValue();
      roleRepository.getRoleByCode.mockResolvedValue(mockRole);
      userRepository.findByEmail.mockResolvedValue(null); // New user
      userRepository.createUser.mockResolvedValue(mockUser);
      userRepository.assignRole.mockResolvedValue();
      bcrypt.hash.mockResolvedValue(mockPasswordHash);
      userRepository.upsertCredential.mockResolvedValue();
      userRepository.createCustomerProfile.mockResolvedValue();
      tokenRepository.createToken.mockResolvedValue();
      generateOTP.mockReturnValue(mockOtp);
      sendOtpEmail.mockResolvedValue();

      // WHEN - Customer registers with valid payload
      const result = await customerService.registerCustomer({
        email: 'NewCustomer@Test.com',
        password: 'SecurePass123',
        firstName: 'Jane',
        lastName: 'Smith',
        phone: '0987654321',
      });

      // THEN - Should return success message and trigger OTP email
      expect(result.message).toBe('Customer registered, please verify email to activate account.');

      // Verify password was hashed
      expect(bcrypt.hash).toHaveBeenCalledWith('SecurePass123');

      // Verify user created with normalized email
      expect(userRepository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'newcustomer@test.com',
          firstName: 'Jane',
          lastName: 'Smith',
          emailVerified: false,
        }),
        expect.anything()
      );

      // Verify OTP token created
      expect(tokenRepository.createToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-123',
          purpose: 'verify_email',
          code: mockOtp,
          ttlMs: 5 * 60 * 1000,
        }),
        expect.anything()
      );

      // Verify OTP email was sent
      expect(sendOtpEmail).toHaveBeenCalledWith(
        'newcustomer@test.com',
        'Jane',
        mockOtp,
        'VERIFY'
      );
    });

    it('should throw error when email already registered and verified', async () => {
      // GIVEN - Existing verified customer with same email
      const mockRole = { id: 'role-customer' };
      const existingUser = { id: 'existing-1', email_verified: true };

      roleRepository.ensureGlobalRoles.mockResolvedValue();
      roleRepository.getRoleByCode.mockResolvedValue(mockRole);
      userRepository.findByEmail.mockResolvedValue(existingUser);
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);

      // WHEN - Attempting to register with existing email
      // THEN - Should throw 409 conflict error
      await expect(
        customerService.registerCustomer({
          email: 'existing@test.com',
          password: 'password123',
        })
      ).rejects.toMatchObject({
        message: 'Email already registered',
        status: 409,
      });
    });
  });

  // =========================================================================
  // TEST #4: verifyCustomer() - EDGE CASES
  // =========================================================================
  describe('verifyCustomer() - Edge Cases', () => {
    it('should throw error when email is null', async () => {
      // GIVEN - Null email input
      // WHEN - Attempting verification with null email
      // THEN - Should throw validation error
      await expect(
        customerService.verifyCustomer(null, '123456')
      ).rejects.toMatchObject({
        message: 'Email and OTP are required',
      });
    });

    it('should throw error when OTP is empty string', async () => {
      // GIVEN - Empty OTP input
      // WHEN - Attempting verification with empty OTP
      // THEN - Should throw validation error
      await expect(
        customerService.verifyCustomer('test@test.com', '')
      ).rejects.toMatchObject({
        message: 'Email and OTP are required',
      });
    });

    it('should throw 404 when user not found', async () => {
      // GIVEN - User does not exist
      userRepository.findByEmail.mockResolvedValue(null);

      // WHEN - Attempting verification for non-existent user
      // THEN - Should throw 404 error
      await expect(
        customerService.verifyCustomer('unknown@test.com', '123456')
      ).rejects.toMatchObject({
        message: 'User not found',
        status: 404,
      });
    });

    it('should throw 403 when account is not a customer', async () => {
      // GIVEN - User exists but is not a customer role
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      userRepository.getUserRoleCodes.mockResolvedValue(['owner']);

      // WHEN - Attempting customer verification for non-customer
      // THEN - Should throw 403 forbidden
      await expect(
        customerService.verifyCustomer('owner@test.com', '123456')
      ).rejects.toMatchObject({
        message: 'Account is not a customer',
        status: 403,
      });
    });

    it('should throw error when OTP code is invalid', async () => {
      // GIVEN - User exists, is customer, but OTP is wrong
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);
      tokenRepository.consumeToken.mockResolvedValue({
        success: false,
        reason: 'invalid_code',
      });

      // WHEN - Attempting verification with wrong OTP
      // THEN - Should throw "OTP invalid" error
      await expect(
        customerService.verifyCustomer('test@test.com', 'wrong_otp')
      ).rejects.toMatchObject({
        message: 'OTP invalid',
        status: 400,
      });
    });

    it('should throw error when OTP is expired', async () => {
      // GIVEN - User exists, is customer, but OTP has expired
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);
      tokenRepository.consumeToken.mockResolvedValue({
        success: false,
        reason: 'expired',
      });

      // WHEN - Attempting verification with expired OTP
      // THEN - Should throw "OTP not found or expired" error
      await expect(
        customerService.verifyCustomer('test@test.com', '123456')
      ).rejects.toMatchObject({
        message: 'OTP not found or expired',
        status: 400,
      });
    });

    it('should successfully verify and return token when OTP is valid', async () => {
      // GIVEN - Valid user with correct OTP
      const mockUser = { id: 'user-123', email: 'test@test.com', first_name: 'John', last_name: 'Doe' };
      userRepository.findByEmail.mockResolvedValue(mockUser);
      userRepository.getUserRoleCodes.mockResolvedValue(['customer']);
      tokenRepository.consumeToken.mockResolvedValue({ success: true });
      userRepository.updateUser.mockResolvedValue();
      jwt.sign.mockReturnValue('new_jwt_token');

      // WHEN - Verifying with correct OTP
      const result = await customerService.verifyCustomer('test@test.com', '123456');

      // THEN - Should return success with token
      expect(result.message).toBe('Verification successful');
      expect(result.token).toBe('new_jwt_token');
      expect(result.user.emailVerified).toBe(true);
      expect(userRepository.updateUser).toHaveBeenCalledWith('user-123', { emailVerified: true });
    });
  });

  // =========================================================================
  // TEST #7: resetPassword() - EDGE CASES
  // =========================================================================
  describe('resetPassword() - Edge Cases', () => {
    it('should throw error when email is missing', async () => {
      // GIVEN - Missing email
      // WHEN - Attempting password reset without email
      // THEN - Should throw validation error
      await expect(
        customerService.resetPassword({ email: null, otp: '123456', newPassword: 'newpass' })
      ).rejects.toMatchObject({
        message: 'Email, OTP and new password are required',
      });
    });

    it('should throw error when OTP is missing', async () => {
      // GIVEN - Missing OTP
      // WHEN - Attempting password reset without OTP
      // THEN - Should throw validation error
      await expect(
        customerService.resetPassword({ email: 'test@test.com', otp: '', newPassword: 'newpass' })
      ).rejects.toMatchObject({
        message: 'Email, OTP and new password are required',
      });
    });

    it('should throw error when newPassword is missing', async () => {
      // GIVEN - Missing new password
      // WHEN - Attempting password reset without new password
      // THEN - Should throw validation error
      await expect(
        customerService.resetPassword({ email: 'test@test.com', otp: '123456', newPassword: null })
      ).rejects.toMatchObject({
        message: 'Email, OTP and new password are required',
      });
    });

    it('should throw 404 when user not found', async () => {
      // GIVEN - User does not exist
      userRepository.findByEmail.mockResolvedValue(null);

      // WHEN - Attempting password reset for non-existent user
      // THEN - Should throw 404 error
      await expect(
        customerService.resetPassword({ email: 'unknown@test.com', otp: '123456', newPassword: 'newpass' })
      ).rejects.toMatchObject({
        message: 'User not found',
        status: 404,
      });
    });

    it('should throw error when OTP is invalid or expired', async () => {
      // GIVEN - User exists but OTP is invalid
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-customer' });
      tokenRepository.consumeToken.mockResolvedValue({ success: false });

      // WHEN - Attempting password reset with invalid OTP
      // THEN - Should throw OTP error
      await expect(
        customerService.resetPassword({ email: 'test@test.com', otp: 'wrong', newPassword: 'newpass' })
      ).rejects.toMatchObject({
        message: 'OTP invalid or expired',
        status: 400,
      });
    });

    it('should successfully reset password when all inputs are valid', async () => {
      // GIVEN - Valid user with correct OTP
      const mockUser = { id: 'user-123' };
      const mockRole = { id: 'role-customer' };
      userRepository.findByEmail.mockResolvedValue(mockUser);
      roleRepository.getRoleByCode.mockResolvedValue(mockRole);
      tokenRepository.consumeToken.mockResolvedValue({ success: true });
      bcrypt.hash.mockResolvedValue('new_hashed_password');
      userRepository.upsertCredential.mockResolvedValue();

      // WHEN - Resetting password with valid data
      const result = await customerService.resetPassword({
        email: 'test@test.com',
        otp: '123456',
        newPassword: 'newSecurePassword',
      });

      // THEN - Should return success and update credential
      expect(result.message).toBe('Password updated successfully');
      expect(bcrypt.hash).toHaveBeenCalledWith('newSecurePassword');
      expect(userRepository.upsertCredential).toHaveBeenCalledWith({
        userId: 'user-123',
        roleId: 'role-customer',
        passwordHash: 'new_hashed_password',
        isTemp: false,
      });
    });
  });
});

describe('Restaurant Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (callback) => {
      const mockClient = {};
      return callback(mockClient);
    });
  });

  // =========================================================================
  // TEST #5: ownerLogin() - ERROR CASES
  // =========================================================================
  describe('ownerLogin() - Error Cases', () => {
    it('should reject with 401 when email is missing', async () => {
      // GIVEN - No email provided
      // WHEN - Attempting owner login without email
      // THEN - Should throw 401 error
      await expect(
        restaurantService.ownerLogin({ email: null, password: 'password' })
      ).rejects.toMatchObject({
        message: 'Email and password are required',
        status: 401,
      });
    });

    it('should reject with 401 when password is missing', async () => {
      // GIVEN - No password provided
      // WHEN - Attempting owner login without password
      // THEN - Should throw 401 error
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: '' })
      ).rejects.toMatchObject({
        message: 'Email and password are required',
        status: 401,
      });
    });

    it('should reject with 401 when user does not exist', async () => {
      // GIVEN - User not found in database
      userRepository.findByEmail.mockResolvedValue(null);

      // WHEN - Attempting login with non-existent email
      // THEN - Should throw "Invalid credentials"
      await expect(
        restaurantService.ownerLogin({ email: 'unknown@test.com', password: 'password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });

    it('should reject with 401 when owner credential does not exist', async () => {
      // GIVEN - User exists but has no owner credential
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue(null);

      // WHEN - Attempting login without owner credentials
      // THEN - Should throw "Invalid credentials"
      await expect(
        restaurantService.ownerLogin({ email: 'test@test.com', password: 'password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });

    it('should reject with 403 when password is temporary (is_temp = true)', async () => {
      // GIVEN - Owner has temporary password that needs reset
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1' });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue({
        password_hash: 'temp_hash',
        is_temp: true,
      });

      // WHEN - Attempting login with temp password flag set
      // THEN - Should throw "Password reset required before login"
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: 'temp_password' })
      ).rejects.toMatchObject({
        message: 'Password reset required before login',
        status: 403,
      });
    });

    it('should reject with 401 when password is incorrect', async () => {
      // GIVEN - Owner exists with permanent password but wrong password provided
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1', email_verified: true });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue({
        password_hash: 'correct_hash',
        is_temp: false,
      });
      bcrypt.compare.mockResolvedValue(false);

      // WHEN - Attempting login with wrong password
      // THEN - Should throw "Invalid credentials"
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: 'wrong_password' })
      ).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    });

    it('should reject with 403 when email is not verified', async () => {
      // GIVEN - Owner with correct password but unverified email
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1', email_verified: false });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue({
        password_hash: 'correct_hash',
        is_temp: false,
      });
      bcrypt.compare.mockResolvedValue(true);

      // WHEN - Attempting login with unverified email
      // THEN - Should throw "Email not verified"
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: 'correct_password' })
      ).rejects.toMatchObject({
        message: 'Email not verified',
        status: 403,
      });
    });

    it('should reject with 404 when owner profile does not exist', async () => {
      // GIVEN - User verified but no owner profile
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1', email_verified: true });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue({
        password_hash: 'correct_hash',
        is_temp: false,
      });
      bcrypt.compare.mockResolvedValue(true);
      userRepository.getOwnerProfileByUserId.mockResolvedValue(null);

      // WHEN - Attempting login without owner profile
      // THEN - Should throw "Owner profile not found"
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: 'correct_password' })
      ).rejects.toMatchObject({
        message: 'Owner profile not found',
        status: 404,
      });
    });

    it('should reject with 403 when owner status is not approved', async () => {
      // GIVEN - Owner with pending status
      userRepository.findByEmail.mockResolvedValue({ id: 'user-1', email_verified: true });
      roleRepository.getRoleByCode.mockResolvedValue({ id: 'role-owner' });
      userRepository.getCredential.mockResolvedValue({
        password_hash: 'correct_hash',
        is_temp: false,
      });
      bcrypt.compare.mockResolvedValue(true);
      userRepository.getOwnerProfileByUserId.mockResolvedValue({ status: 'pending' });

      // WHEN - Attempting login with unapproved account
      // THEN - Should throw "Owner account pending approval"
      await expect(
        restaurantService.ownerLogin({ email: 'owner@test.com', password: 'correct_password' })
      ).rejects.toMatchObject({
        message: 'Owner account pending approval',
        status: 403,
      });
    });
  });

  // =========================================================================
  // TEST #6: adminApproveOwner() - HAPPY PATH
  // =========================================================================
  describe('adminApproveOwner() - Happy Path', () => {
    it('should approve owner, create temp password, generate OTP, send email, and publish socket event', async () => {
      // GIVEN - Owner awaiting approval with complete profile
      const mockOwner = {
        id: 'owner-123',
        email: 'restaurant@test.com',
        first_name: 'Bob',
        last_name: 'Owner',
      };
      const mockProfile = { status: 'pending' };
      const mockRole = { id: 'role-owner', code: 'owner' };

      userRepository.findById.mockResolvedValue(mockOwner);
      userRepository.getOwnerProfileByUserId.mockResolvedValue(mockProfile);
      roleRepository.ensureGlobalRoles.mockResolvedValue();
      roleRepository.getRoleByCode.mockResolvedValue(mockRole);
      bcrypt.hash.mockResolvedValue('hashed_temp_password');
      generateOTP.mockReturnValue('654321');
      userRepository.updateOwnerProfile.mockResolvedValue();
      userRepository.upsertCredential.mockResolvedValue();
      tokenRepository.createToken.mockResolvedValue();
      sendOtpEmail.mockResolvedValue();
      publishSocketEvent.mockReturnValue();

      // WHEN - Admin approves the owner
      const result = await restaurantService.adminApproveOwner({
        ownerId: 'owner-123',
        adminUserId: 'admin-456',
      });

      // THEN - Should return success message
      expect(result.message).toBe('Owner approved. Verification email sent.');

      // Verify profile was updated to approved
      expect(userRepository.updateOwnerProfile).toHaveBeenCalledWith(
        'owner-123',
        expect.objectContaining({
          status: 'approved',
          approvedBy: 'admin-456',
        }),
        expect.anything()
      );

      // Verify temporary credential was created
      expect(userRepository.upsertCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-123',
          roleId: 'role-owner',
          isTemp: true,
        }),
        expect.anything()
      );

      // Verify OTP token was created
      expect(tokenRepository.createToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'owner-123',
          purpose: 'verify_email',
          code: '654321',
        }),
        expect.anything()
      );

      // Verify email was sent with OTP and temp password
      expect(sendOtpEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'restaurant@test.com',
          otp: '654321',
          purpose: 'OWNER_VERIFY',
        })
      );

      // Verify socket event was published
      expect(publishSocketEvent).toHaveBeenCalledWith(
        'owner.approved',
        expect.objectContaining({
          ownerId: 'owner-123',
          adminUserId: 'admin-456',
        }),
        ['admin:restaurants', 'restaurant-owner:owner-123']
      );
    });

    it('should throw error when ownerId is not provided', async () => {
      // GIVEN - Missing ownerId
      // WHEN - Attempting to approve without ownerId
      // THEN - Should throw validation error
      await expect(
        restaurantService.adminApproveOwner({ ownerId: null, adminUserId: 'admin-1' })
      ).rejects.toMatchObject({
        message: 'ownerId is required',
      });
    });

    it('should throw 404 when owner not found', async () => {
      // GIVEN - Owner does not exist
      userRepository.findById.mockResolvedValue(null);

      // WHEN - Attempting to approve non-existent owner
      // THEN - Should throw 404 error
      await expect(
        restaurantService.adminApproveOwner({ ownerId: 'unknown', adminUserId: 'admin-1' })
      ).rejects.toMatchObject({
        message: 'Owner not found',
        status: 404,
      });
    });

    it('should return early if owner is already approved', async () => {
      // GIVEN - Owner already approved
      userRepository.findById.mockResolvedValue({ id: 'owner-1', email: 'owner@test.com' });
      userRepository.getOwnerProfileByUserId.mockResolvedValue({ status: 'approved' });

      // WHEN - Attempting to approve already approved owner
      const result = await restaurantService.adminApproveOwner({
        ownerId: 'owner-1',
        adminUserId: 'admin-1',
      });

      // THEN - Should return "already approved" message without side effects
      expect(result.message).toBe('Owner already approved');
      expect(sendOtpEmail).not.toHaveBeenCalled();
      expect(publishSocketEvent).not.toHaveBeenCalled();
    });
  });
});
