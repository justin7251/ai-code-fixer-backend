const jwt = require('jsonwebtoken');

const isValidJWTFormat = (token) => {
    // JWT should have three parts separated by dots
    const parts = token.split('.');
    return parts.length === 3 && 
           parts.every(part => /^[A-Za-z0-9-_]+$/.test(part));
};

const generateToken = (userId) => {
    try {
        console.log('[DEBUG] Generating token for userId:', userId);
        console.log('[DEBUG] Using JWT_SECRET:', process.env.JWT_SECRET ? 'Secret exists' : 'No secret found');

        if (!process.env.JWT_SECRET) {
            throw new Error('JWT_SECRET is not defined in environment variables');
        }

        const token = jwt.sign(
            { id: userId },
            process.env.JWT_SECRET,
            { 
                expiresIn: '24h',
                algorithm: 'HS256'
            }
        );

        return token;
    } catch (error) {
        console.error('[TOKEN GENERATION ERROR]', error);
        throw error;
    }
};

const verifyToken = (token) => {
    try {
        if (!token) {
            throw new Error('Token is required');
        }

        // Clean the token (remove any whitespace or quotes)
        const cleanToken = token.trim().replace(/['"]/g, '');
        console.log('[DEBUG] Cleaned token:', cleanToken);

        // Validate JWT format
        if (!isValidJWTFormat(cleanToken)) {
            throw new Error('Token is not in valid JWT format');
        }

        const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET, {
            algorithms: ['HS256']
        });
        
        console.log('[DEBUG] Token successfully decoded:', decoded);

        if (!decoded.userId) {
            throw new Error('Token payload is invalid: missing user id');
        }

        return decoded;
    } catch (error) {
        console.error('[TOKEN VERIFICATION ERROR]', error);
        if (error.name === 'JsonWebTokenError') {
            throw new Error(`Invalid token signature: ${error.message}`);
        } else if (error.name === 'TokenExpiredError') {
            throw new Error('Token has expired');
        } else {
            throw new Error(`Token verification failed: ${error.message}`);
        }
    }
};

module.exports = {
    generateToken,
    verifyToken
}; 