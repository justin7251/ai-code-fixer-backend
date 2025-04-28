const express = require('express');
const cors = require('cors');
const app = express();

// Import routes
const repositoriesRouter = require('./routes/repositories');
const projectsRouter = require('./routes/projects');
const authRouter = require('./routes/auth');
const analysisRouter = require('./routes/analysis');
const protectedRoutes = require('./routes/protected');
const codeQualityRouter = require('./routes/code-quality');

// Import middlewares
const { corsOptions } = require('./middlewares/cors');
const authMiddleware = require('./middlewares/auth');

// Apply CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Parse JSON bodies
app.use(express.json());

// Log all requests for debugging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

// Public routes (no auth required)
app.use('/api/auth', authRouter);

// Protected routes (auth required)
app.use('/api/repositories', authMiddleware, repositoriesRouter);
app.use('/api/projects', authMiddleware, projectsRouter);
app.use('/api/analysis', authMiddleware, analysisRouter);
app.use('/api/protected', protectedRoutes);
app.use('/api/code-quality', authMiddleware, codeQualityRouter);

// Health check route
app.get('/', (req, res) => {
    res.json({ status: 'API is running' });
});

// Consolidated API routes
app.use('/api', (req, res, next) => {
    // Add any global API middleware here
    next();
});

// Main API routes (support both /api and direct routes)
app.use(['/api/repositories', '/repositories'], repositoriesRouter);
app.use(['/api/projects', '/projects'], projectsRouter);
app.use(['/api/analysis', '/analysis'], analysisRouter);
app.use(['/api/code-quality', '/code-quality'], codeQualityRouter);

// Error handling for JSON parsing errors
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('JSON Parse Error:', err.message);
        return res.status(400).json({ 
            success: false, 
            error: 'Bad Request',
            message: 'Invalid JSON in request body' 
        });
    }
    next(err);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    
    // Handle CORS errors
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ 
            success: false,
            error: 'CORS Error',
            message: 'Request not allowed from this origin'
        });
    }
    
    // Handle authentication errors
    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            error: 'Authentication Error',
            message: 'Your session has expired. Please log in again.'
        });
    }
    
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            error: 'Authentication Error',
            message: 'Invalid authentication token'
        });
    }
    
    // Handle client errors (4xx)
    if (err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({
            success: false,
            error: err.title || 'Client Error',
            message: err.message
        });
    }
    
    // Default server error response
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

module.exports = app; 