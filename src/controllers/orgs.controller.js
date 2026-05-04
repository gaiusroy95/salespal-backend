const orgService = require('../services/org.service');

exports.getMyOrg = async (req, res, next) => {
  try {
    const org = await orgService.getUserOrg(req.user.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    res.json(org);
  } catch (err) {
    next(err);
  }
};

exports.getOrg = async (req, res, next) => {
  try {
    const org = await orgService.getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    res.json(org);
  } catch (err) {
    next(err);
  }
};

exports.createOrg = async (req, res, next) => {
  try {
    const { name, slug } = req.body;
    if (!name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    const org = await orgService.createOrg(req.user.id, { name, slug });
    res.status(201).json(org);
  } catch (err) {
    next(err);
  }
};

exports.updateOrg = async (req, res, next) => {
  try {
    const updated = await orgService.updateOrg(req.params.id, req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.getOrgMembers = async (req, res, next) => {
  try {
    const members = await orgService.getOrgMembers(req.params.id);
    res.json(members);
  } catch (err) {
    next(err);
  }
};

exports.inviteMember = async (req, res, next) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'email is required' } });
    const member = await orgService.inviteMember(req.params.id, email, role || 'member');
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
};

exports.removeMember = async (req, res, next) => {
  try {
    const removed = await orgService.removeMember(req.params.id, req.params.userId);
    if (!removed) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found' } });
    res.json({ message: 'Member removed' });
  } catch (err) {
    next(err);
  }
};
