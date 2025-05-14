const jwt = require("jsonwebtoken");
const { verifyToken } = require("../utils/token");

function authenticateToken(req, res, next) {
    try {
        console.log('[DEBUG] Auth middleware started');
        console.log('[DEBUG] Request headers:', JSON.stringify(req.headers, null, 2));

        const authHeader = req.headers["authorization"];
        console.log('[DEBUG] Body', req.body);
        if (!authHeader) {
            console.log('[DEBUG] No authorization header found');
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'No authorization header provided'
            });
        }

        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            console.log('[DEBUG] No token found in authorization header');
            return res.status(401).json({
                success: false,
                error: 'Unauthorized',
                message: 'No token provided'
            });
        }

        console.log('[DEBUG] Attempting to verify token');
        try {
            const user = verifyToken(token);
            console.log('[DEBUG] Token verified successfully');
            req.user = user;
            next();
        } catch (err) {
            console.error('[AUTH ERROR]', err);
            return res.status(403).json({
                success: false,
                error: 'Forbidden',
                message: err.message || 'Invalid token'
            });
        }
    } catch (error) {
        console.error('[AUTH ERROR]', error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            message: 'Authentication failed'
        });
    }
}

module.exports = authenticateToken; 