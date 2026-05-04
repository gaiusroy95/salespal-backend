const { Router } = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/projects.controller');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

router.get('/', [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })], validate, ctrl.listProjects);
router.get('/:id/brain-drive', [param('id').isUUID()], validate, ctrl.listProjectBrainDrive);
router.get('/:id', [param('id').isUUID()], validate, ctrl.getProject);
router.post('/', [body('name').notEmpty().withMessage('Project name is required')], validate, ctrl.createProject);
router.put('/:id', [param('id').isUUID()], validate, ctrl.updateProject);
router.post('/:id/ingest', [param('id').isUUID()], validate, upload.any(), ctrl.ingestProjectKnowledge);
router.post('/:id/context', [param('id').isUUID(), body('q').notEmpty().withMessage('q is required')], validate, ctrl.getProjectKnowledgeContext);
router.post('/:id/archive', [param('id').isUUID()], validate, ctrl.archiveProject);
router.delete('/:id', [param('id').isUUID()], validate, ctrl.deleteProject);

module.exports = router;
