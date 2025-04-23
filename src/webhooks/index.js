const express = require('express');
const router = express.Router();

// Basic webhook handler
router.post('/', (req, res) => {
    console.log('Webhook received:', req.body);
    res.status(200).json({ received: true });
});

module.exports = router; 