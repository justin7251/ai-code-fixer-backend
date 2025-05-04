require('dotenv').config();
const axios = require('axios');

// Test function for code-quality endpoints
async function testCodeQualityEndpoint() {
  try {
    // Verify JWT_SECRET is set
    if (!process.env.JWT_SECRET) {
      console.error('ERROR: JWT_SECRET is not defined in environment variables');
      console.log('Make sure your .env file contains JWT_SECRET=your-secret-key');
      return;
    }
    
    console.log('Testing code-quality endpoint...');
    console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
    
    // First get a token for authentication
    console.log('Getting authentication token...');
    const authResponse = await axios.post('http://localhost:5001/api/auth/token', {
      userId: '12345' // Test user ID
    });
    
    const token = authResponse.data.token;
    console.log('Token received:', token.substring(0, 15) + '...');
    
    // Simple health check first
    console.log('Testing root endpoint...');
    await axios.get('http://localhost:5001/');
    
    // Test the code-quality endpoint with authentication
    console.log('Testing /api/code-quality/tools endpoint...');
    const toolsResponse = await axios.get('http://localhost:5001/api/code-quality/tools', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    
    console.log('Tools response:', JSON.stringify(toolsResponse.data, null, 2));
    
    // Test the analyze endpoint
    console.log('Testing /api/code-quality/analyze endpoint...');
    const analyzeResponse = await axios.post('http://localhost:5001/api/code-quality/analyze', 
      {
        repositoryUrl: 'https://github.com/octocat/Hello-World',
        language: 'javascript',
        options: {}
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );
    
    console.log('Analyze response:', JSON.stringify(analyzeResponse.data, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
    
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response status:', error.response.status);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received. Server may have crashed.');
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Request error:', error.message);
    }
  }
}

// Run the test
testCodeQualityEndpoint(); 