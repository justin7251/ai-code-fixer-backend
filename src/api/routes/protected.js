const express = require("express");
const router = express.Router();
const authenticateToken = require("../middlewares/auth");

router.get("/protected", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.sub; // GitHub user ID from the token

    // Example: Fetch user data from your database
    // const userData = await db.users.findOne({ githubId: userId });

    res.json({
      success: true,
      data: {
        userId,
        message: "Access granted to protected route"
      }
    });
  } catch (error) {
    console.error('[PROTECTED ROUTE ERROR]', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to process protected route'
    });
  }
});

module.exports = router; 