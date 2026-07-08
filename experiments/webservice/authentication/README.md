This folder contains different authentication methods for securing web services.

The deployment script will only copy the content of the configured auth method. Therefore it is important to always 
have the file index.js in the root of this folder. This file should export the authentication middleware function:

```javascript
// index.js
async function verifyJWT(token) : Promise<boolean> {
    // Your JWT verification logic here
}
```