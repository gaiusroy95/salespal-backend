const authService = require('../services/auth.service');
const logger = require('../config/logger');
const { sanitizeAuthErrorMessage } = require('../utils/publicApiFallbacks');

function forwardAuthError(err, res, next) {
  if (err?.statusCode && err.statusCode < 500) {
    return next(err);
  }
  logger.error('[auth] unexpected failure', { message: err?.message || err, code: err?.code });
  const safeMessage = sanitizeAuthErrorMessage(err?.message);
  return res.status(err?.statusCode && err.statusCode < 500 ? err.statusCode : 503).json({
    error: {
      code: err?.code || 'AUTH_UNAVAILABLE',
      message: safeMessage,
    },
  });
}

async function register(req, res, next) {
  try {
    const { email, password, fullName } = req.body;
    const result = await authService.registerUser({ email, password, fullName });

    res.status(201).json(result);
  } catch (err) {
    return forwardAuthError(err, res, next);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.loginUser({ email, password });

    res.json({
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      err.message = sanitizeAuthErrorMessage(err.message);
      return next(err);
    }
    return forwardAuthError(err, res, next);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'refreshToken is required' },
      });
    }

    const result = await authService.refreshAccessToken(refreshToken);

    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await authService.revokeRefreshToken(refreshToken);
    }

    // Also revoke all tokens if user is authenticated
    if (req.user) {
      await authService.revokeAllRefreshTokens(req.user.id);
    }

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

const googleLogin = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Google token is required' });
    }

    const result = await authService.googleLogin(token);
    res.json(result);
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      return next(err);
    }
    return forwardAuthError(err, res, next);
  }
};

async function verify(req, res, next) {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: { message: 'Token is required' } });
    }

    await authService.verifyEmailToken(token);
    
    // Redirect to frontend homepage with a success message (auth modal lives there)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/?verified=true`);
  } catch (err) {
    // Redirect to frontend homepage with an error message
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/?error=invalid_token`);
  }
}

module.exports = {
    register,
    login,
    refresh,
    logout,
    googleLogin,
    verify
};
