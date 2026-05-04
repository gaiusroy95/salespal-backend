const { Router } = require('express');
const ctrl = require('../controllers/orgs.controller');

const router = Router();

// GET /orgs/me — get current user's org
router.get('/me', ctrl.getMyOrg);

// POST /orgs — create org
router.post('/', ctrl.createOrg);

// GET /orgs/:id — get org by id
router.get('/:id', ctrl.getOrg);

// PUT /orgs/:id — update org
router.put('/:id', ctrl.updateOrg);

// GET /orgs/:id/members — list members
router.get('/:id/members', ctrl.getOrgMembers);

// POST /orgs/:id/members — invite member
router.post('/:id/members', ctrl.inviteMember);

// DELETE /orgs/:id/members/:userId — remove member
router.delete('/:id/members/:userId', ctrl.removeMember);

module.exports = router;
