const { Router } = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/support.controller');

const router = Router();

router.get('/', [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })], validate, ctrl.listTickets);
router.get('/:id', [param('id').isUUID()], validate, ctrl.getTicket);
router.post('/', [body('subject').notEmpty().withMessage('Subject is required')], validate, ctrl.createTicket);
router.put('/:id', [param('id').isUUID()], validate, ctrl.updateTicket);
router.post('/:id/comments', [param('id').isUUID(), body('content').notEmpty().withMessage('Comment content is required')], validate, ctrl.addComment);
router.delete('/:id', [param('id').isUUID()], validate, ctrl.deleteTicket);

module.exports = router;
