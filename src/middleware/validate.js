const { validationResult } = require('express-validator');

/**
 * Middleware that checks express-validator results and returns
 * a structured VALIDATION_ERROR response if any rules failed.
 * Use after express-validator check/body/query chains.
 */
function validate(req, res, next) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: errors.array().map((e) => ({
          field: e.path,
          message: e.msg,
          value: e.value,
        })),
      },
    });
  }

  next();
}

module.exports = validate;
