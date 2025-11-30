/**
 * Integration Test: IR-10 - Admin Routes Unprotected
 * 
 * Risk: admin.routes.js has NO authentication middleware
 *       Anyone can call admin endpoints to approve/reject restaurant owners
 * 
 * Impact: CRITICAL - Public access to admin functionality
 * 
 * Target Code (admin.routes.js):
 * ```javascript
 * const router = express.Router();
 * 
 * router.get('/customers', adminController.listCustomers);
 * router.get('/customers/:id', adminController.customerDetails);
 * router.patch('/customers/:id/status', adminController.updateCustomerStatus);
 * 
 * router.get('/owners', adminController.listOwnerApplicants);
 * router.post('/owners/:id/approve', adminController.approveOwner);
 * router.post('/owners/:id/reject', adminController.rejectOwner);
 * // NO authMiddleware anywhere!
 * ```
 * 
 * Reproduction:
 *   curl http://localhost:3001/api/admin/owners
 *   curl -X POST http://localhost:3001/api/admin/owners/1/approve
 */

const request = require('supertest');
const express = require('express');

describe('IR-10: Admin Routes Unprotected - No Authentication Required', () => {
  let app;
  let mockAdminService;
  let mockRestaurantService;
  
  beforeEach(() => {
    jest.resetModules();
    
    // Mock admin service
    mockAdminService = {
      listCustomers: jest.fn().mockResolvedValue({
        items: [
          { id: 1, email: 'customer1@example.com', phone: '555-0001' },
          { id: 2, email: 'customer2@example.com', phone: '555-0002' },
        ],
      }),
      getCustomerDetails: jest.fn().mockResolvedValue({
        addresses: [{ id: 1, street: 'Secret Address' }],
        profile: { tier: 'gold', loyalty_points: 1500 },
      }),
      setCustomerActiveStatus: jest.fn().mockResolvedValue({ message: 'Status updated' }),
      listOwnerApplicants: jest.fn().mockResolvedValue({
        items: [
          { id: 10, email: 'pending-owner@example.com', status: 'pending', tax_code: '1234567890' },
        ],
      }),
      approveOwner: jest.fn().mockResolvedValue({ message: 'Owner approved. Verification email sent.' }),
      rejectOwner: jest.fn().mockResolvedValue({ message: 'Owner rejected.' }),
    };
    
    jest.doMock('../../services/admin.service', () => mockAdminService);
    
    // Create app with admin routes
    app = express();
    app.use(express.json());
    
    const adminRoutes = require('../../routes/admin.routes');
    app.use('/api/admin', adminRoutes);
    
    // Error handler
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ message: err.message });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Customer Data Exposure', () => {
    test('VULNERABILITY: List all customers WITHOUT authentication', async () => {
      const response = await request(app)
        .get('/api/admin/customers')
        // NO Authorization header!
        .expect(200);

      expect(response.body.items).toBeDefined();
      expect(response.body.items.length).toBeGreaterThan(0);
      expect(mockAdminService.listCustomers).toHaveBeenCalled();
    });

    test('VULNERABILITY: Get customer details (PII) WITHOUT authentication', async () => {
      const response = await request(app)
        .get('/api/admin/customers/1')
        .expect(200);

      // Attacker can see customer addresses and profile
      expect(response.body.addresses).toBeDefined();
      expect(response.body.profile).toBeDefined();
      expect(mockAdminService.getCustomerDetails).toHaveBeenCalledWith('1');
    });

    test('VULNERABILITY: Disable customer account WITHOUT authentication', async () => {
      const response = await request(app)
        .patch('/api/admin/customers/1/status')
        .send({ isActive: false })
        .expect(200);

      expect(response.body.message).toBe('Status updated');
      expect(mockAdminService.setCustomerActiveStatus).toHaveBeenCalledWith('1', false);
    });
  });

  describe('Owner Approval Manipulation', () => {
    test('VULNERABILITY: List pending owner applications WITHOUT authentication', async () => {
      const response = await request(app)
        .get('/api/admin/owners')
        .expect(200);

      // Attacker can see all pending restaurant owner applications
      // Including sensitive business information (tax codes, etc.)
      expect(response.body.items).toBeDefined();
      expect(mockAdminService.listOwnerApplicants).toHaveBeenCalled();
    });

    test('VULNERABILITY: Approve restaurant owner WITHOUT authentication', async () => {
      const response = await request(app)
        .post('/api/admin/owners/10/approve')
        // No auth - anyone can approve owners!
        .expect(200);

      expect(response.body.message).toContain('approved');
      expect(mockAdminService.approveOwner).toHaveBeenCalledWith('10', undefined);
    });

    test('VULNERABILITY: Reject restaurant owner WITHOUT authentication', async () => {
      const response = await request(app)
        .post('/api/admin/owners/10/reject')
        .send({ reason: 'Malicious rejection by attacker' })
        .expect(200);

      expect(response.body.message).toContain('rejected');
      expect(mockAdminService.rejectOwner).toHaveBeenCalled();
    });
  });

  describe('Attack Scenarios', () => {
    test('ATTACK: Mass approve all pending owners (sabotage)', async () => {
      // Attacker first lists all pending owners
      mockAdminService.listOwnerApplicants.mockResolvedValue({
        items: [
          { id: 10, status: 'pending' },
          { id: 11, status: 'pending' },
          { id: 12, status: 'pending' },
        ],
      });

      const listResponse = await request(app)
        .get('/api/admin/owners')
        .query({ status: 'pending' });

      const pendingOwners = listResponse.body.items;

      // Attacker approves all of them
      for (const owner of pendingOwners) {
        await request(app)
          .post(`/api/admin/owners/${owner.id}/approve`)
          .expect(200);
      }

      expect(mockAdminService.approveOwner).toHaveBeenCalledTimes(3);
    });

    test('ATTACK: Mass reject all pending owners (denial of service)', async () => {
      mockAdminService.listOwnerApplicants.mockResolvedValue({
        items: [
          { id: 10, status: 'pending' },
          { id: 11, status: 'pending' },
        ],
      });

      const listResponse = await request(app)
        .get('/api/admin/owners');

      for (const owner of listResponse.body.items) {
        await request(app)
          .post(`/api/admin/owners/${owner.id}/reject`)
          .send({ reason: 'Rejected by attacker' })
          .expect(200);
      }

      expect(mockAdminService.rejectOwner).toHaveBeenCalledTimes(2);
    });

    test('ATTACK: Disable all customer accounts', async () => {
      mockAdminService.listCustomers.mockResolvedValue({
        items: [
          { id: 1 },
          { id: 2 },
          { id: 3 },
        ],
      });

      const listResponse = await request(app)
        .get('/api/admin/customers');

      for (const customer of listResponse.body.items) {
        await request(app)
          .patch(`/api/admin/customers/${customer.id}/status`)
          .send({ isActive: false })
          .expect(200);
      }

      expect(mockAdminService.setCustomerActiveStatus).toHaveBeenCalledTimes(3);
    });
  });
});

/**
 * REMEDIATION:
 * 
 * Add admin authentication middleware to admin routes:
 * 
 * ```javascript
 * const express = require('express');
 * const jwt = require('jsonwebtoken');
 * const adminController = require('../controllers/admin.controller');
 * 
 * const router = express.Router();
 * const JWT_SECRET = process.env.JWT_SECRET || 'secret';
 * 
 * // Admin auth middleware
 * function adminAuthMiddleware(req, res, next) {
 *   const header = req.headers.authorization;
 *   if (!header) {
 *     return res.status(401).json({ message: 'Unauthorized' });
 *   }
 * 
 *   const [scheme, token] = header.split(' ');
 *   if (scheme !== 'Bearer' || !token) {
 *     return res.status(401).json({ message: 'Invalid authorization format' });
 *   }
 * 
 *   try {
 *     const payload = jwt.verify(token, JWT_SECRET);
 *     
 *     // Verify admin role
 *     if (payload.role !== 'admin') {
 *       return res.status(403).json({ message: 'Admin access required' });
 *     }
 *     
 *     req.admin = payload;
 *     return next();
 *   } catch (err) {
 *     return res.status(401).json({ message: 'Invalid or expired token' });
 *   }
 * }
 * 
 * // Apply to all admin routes
 * router.use(adminAuthMiddleware);
 * 
 * router.get('/customers', adminController.listCustomers);
 * // ... rest of routes
 * ```
 */
