const http = require('http');
const { handleError, ValidationError, TimeoutError, ShutdownError, InternalError } = require('./lib/errors');
const { validateRequest } = require('./lib/validation');
const { initializeShutdown, registerConnection, unregisterConnection, isShuttingDown } = require('./lib/shutdown');

const hostname = '127.0.0.1';
const port = 3000;

// Connection registry for tracking active HTTP connections
const activeConnections = new Map();
let connectionId = 0;

// Request timeout configuration (30 seconds)
const REQUEST_TIMEOUT = 30000;

// Enhanced request handler with comprehensive error handling and validation
const requestHandler = async (req, res) => {
  const startTime = Date.now();
  const currentConnectionId = ++connectionId;
  
  // Register connection for tracking during graceful shutdown
  registerConnection(currentConnectionId, req.socket);
  activeConnections.set(currentConnectionId, {
    socket: req.socket,
    startTime,
    url: req.url,
    method: req.method
  });

  try {
    // Check if server is shutting down - reject new requests
    if (isShuttingDown()) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      addSecurityHeaders(res);
      res.end(JSON.stringify({ 
        error: 'Server shutting down', 
        message: 'Server is currently shutting down and not accepting new requests' 
      }));
      return;
    }

    // Set request timeout to prevent hanging connections
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        const timeoutError = new TimeoutError('Request timeout exceeded');
        handleError(timeoutError, req, res);
      }
    }, REQUEST_TIMEOUT);

    // Perform comprehensive input validation
    try {
      await validateRequest(req);
    } catch (validationError) {
      clearTimeout(timeoutId);
      if (validationError instanceof ValidationError) {
        handleError(validationError, req, res);
      } else {
        // Unexpected validation error
        const internalError = new InternalError('Validation system error');
        handleError(internalError, req, res);
      }
      return;
    }

    // Clear timeout after successful validation
    clearTimeout(timeoutId);

    // Process valid request - generate response
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    
    // Add comprehensive security headers
    addSecurityHeaders(res);
    
    // Generate the response content
    res.end('Hello, World!\n');

  } catch (error) {
    // Handle any unexpected errors during request processing
    console.error('Unexpected error in request handler:', error);
    
    if (!res.headersSent) {
      const internalError = new InternalError('Internal server error occurred');
      handleError(internalError, req, res);
    }
  } finally {
    // Cleanup: Unregister connection when request completes
    activeConnections.delete(currentConnectionId);
    unregisterConnection(currentConnectionId);
  }
};

// Add comprehensive security headers to all responses
const addSecurityHeaders = (res) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Prevent page from being displayed in frames/iframes
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Basic XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
};

// Create HTTP server with enhanced error handling
const server = http.createServer(requestHandler);

// Comprehensive server-level error handling
server.on('error', (error) => {
  console.error('Server error occurred:', error);
  
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Please choose a different port.`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    console.error(`Permission denied to bind to port ${port}. Try running with elevated privileges.`);
    process.exit(1);
  } else {
    console.error('Unexpected server error:', error.message);
    // Don't exit on unexpected errors, log and continue
  }
});

// Handle client connection errors
server.on('clientError', (error, socket) => {
  console.error('Client connection error:', error.message);
  
  // Send appropriate error response if socket is still writable
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Enhanced connection handling for tracking
server.on('connection', (socket) => {
  // Set socket timeout to prevent hanging connections
  socket.setTimeout(REQUEST_TIMEOUT * 2); // Allow extra time for request processing
  
  socket.on('timeout', () => {
    console.warn('Socket timeout occurred, closing connection');
    socket.destroy();
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error.message);
    // Socket will be cleaned up automatically
  });
});

// Initialize graceful shutdown handling
initializeShutdown(server, activeConnections);

// Enhanced server startup with error handling
const startServer = () => {
  try {
    server.listen(port, hostname, () => {
      console.log(`Server running at http://${hostname}:${port}/`);
      console.log('Server features enabled:');
      console.log('  ✓ Comprehensive error handling');
      console.log('  ✓ Input validation middleware');
      console.log('  ✓ Graceful shutdown capabilities');
      console.log('  ✓ Connection tracking and timeout handling');
      console.log('  ✓ Security headers injection');
      console.log('  ✓ Resource cleanup procedures');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle uncaught exceptions to prevent process termination
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  
  // Attempt graceful shutdown
  if (server && server.listening) {
    console.log('Attempting graceful shutdown due to uncaught exception...');
    server.close(() => {
      console.log('Server closed due to uncaught exception');
      process.exit(1);
    });
    
    // Force exit after timeout
    setTimeout(() => {
      console.error('Forced exit due to shutdown timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(1);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('Stack trace:', reason?.stack);
  
  // Log but don't exit - Node.js will handle this in future versions
  console.warn('Unhandled promise rejection detected. This may cause issues.');
});

// Export server instance for testing purposes
module.exports = { server, activeConnections };

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}
