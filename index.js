const express = require("express");
const path = require('path');
const fs = require('fs');

// Import Express apps from src directory
const apiApp = require("./src/api/app");

// Log environment
const isDev = process.env.NODE_ENV === 'development';
console.log('[DEBUG] Running in:', isDev ? 'DEVELOPMENT' : 'PRODUCTION');

// Function execution monitoring
const monitorExecution = (req, res, next) => {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    res.on('finish', () => {
        const endTime = Date.now();
        const endMemory = process.memoryUsage().heapUsed;
        const executionTime = endTime - startTime;
        const memoryUsed = endMemory - startMemory;

        console.log(`[MONITOR] Request to ${req.path} - Time: ${executionTime}ms, Memory: ${memoryUsed} bytes`);
    });

    next();
};

// Apply monitoring middleware
apiApp.use(monitorExecution);

// Export the Express app for Vercel
module.exports = apiApp;