/**
 * HTTP Request Validation Utilities Module
 * 
 * Provides comprehensive HTTP request validation including method verification,
 * Content-Type header validation, payload size limits, and URL path sanitization
 * to protect against malformed requests and security vulnerabilities.
 * 
 * Features:
 * - HTTP method whitelist validation (405 Method Not Allowed)
 * - Content-Type header validation (415 Unsupported Media Type)
 * - Request size limits enforcement (413 Payload Too Large)
 * - URL path sanitization for directory traversal prevention
 * - Fast-fail validation behavior with synchronous checks
 * 
 * @module validation
 * @requires http
 * @requires url
 * @requires path
 */

const http = require('http');
const url = require('url');
const path = require('path');

// Try to import custom error classes, fallback to built-in Error if not available
let ValidationError, TimeoutError;
try {
    const errors = require('./errors');
    ValidationError = errors.ValidationError;
    TimeoutError = errors.TimeoutError;
} catch (e) {
    // Create minimal error classes if errors module doesn't exist yet
    ValidationError = class ValidationError extends Error {
        constructor(message, statusCode = 400) {
            super(message);
            this.name = 'ValidationError';
            this.statusCode = statusCode;
        }
    };
    TimeoutError = class TimeoutError extends Error {
        constructor(message, statusCode = 408) {
            super(message);
            this.name = 'TimeoutError';
            this.statusCode = statusCode;
        }
    };
}

/**
 * Default validation configuration
 * @type {Object}
 */
const DEFAULT_CONFIG = {
    // Allowed HTTP methods (RFC 7231 compliant)
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
    
    // Allowed Content-Type headers for requests with body
    allowedContentTypes: [
        'application/json',
        'application/x-www-form-urlencoded',
        'text/plain',
        'text/html',
        'text/xml',
        'application/xml',
        'multipart/form-data'
    ],
    
    // Maximum request body size in bytes (default: 1MB)
    maxBodySize: 1024 * 1024,
    
    // Request timeout in milliseconds (default: 30 seconds)
    requestTimeout: 30000,
    
    // Enable strict path validation (prevent directory traversal)
    strictPathValidation: true,
    
    // Enable Content-Type validation for methods with body
    validateContentType: true
};

/**
 * Validates HTTP method against allowed methods list
 * 
 * @param {string} method - HTTP method to validate
 * @param {Array<string>} allowedMethods - Array of allowed HTTP methods
 * @returns {Object} Validation result with isValid and error properties
 * @throws {ValidationError} When method is not allowed
 */
function validateHttpMethod(method, allowedMethods = DEFAULT_CONFIG.allowedMethods) {
    if (!method || typeof method !== 'string') {
        throw new ValidationError('HTTP method is required and must be a string', 400);
    }
    
    const upperMethod = method.toUpperCase();
    
    if (!allowedMethods.includes(upperMethod)) {
        throw new ValidationError(
            `HTTP method '${method}' is not allowed. Allowed methods: ${allowedMethods.join(', ')}`,
            405
        );
    }
    
    return {
        isValid: true,
        method: upperMethod
    };
}

/**
 * Validates Content-Type header for requests that should have a body
 * 
 * @param {string} method - HTTP method
 * @param {string} contentType - Content-Type header value
 * @param {Array<string>} allowedTypes - Array of allowed content types
 * @returns {Object} Validation result with isValid and parsedContentType properties
 * @throws {ValidationError} When Content-Type is invalid or not allowed
 */
function validateContentType(method, contentType, allowedTypes = DEFAULT_CONFIG.allowedContentTypes) {
    const methodsWithBody = ['POST', 'PUT', 'PATCH'];
    
    // Skip Content-Type validation for methods that typically don't have a body
    if (!methodsWithBody.includes(method.toUpperCase())) {
        return {
            isValid: true,
            parsedContentType: null,
            skipValidation: true
        };
    }
    
    if (!contentType) {
        throw new ValidationError(
            `Content-Type header is required for ${method} requests`,
            400
        );
    }
    
    // Parse Content-Type header (handle charset, boundary, etc.)
    const parsedContentType = contentType.split(';')[0].trim().toLowerCase();
    
    if (!allowedTypes.some(type => parsedContentType === type.toLowerCase())) {
        throw new ValidationError(
            `Content-Type '${parsedContentType}' is not supported. Allowed types: ${allowedTypes.join(', ')}`,
            415
        );
    }
    
    return {
        isValid: true,
        parsedContentType: parsedContentType,
        fullContentType: contentType
    };
}

/**
 * Validates request payload size limits
 * 
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {number} maxSize - Maximum allowed payload size in bytes
 * @returns {Object} Validation result with isValid and estimatedSize properties
 * @throws {ValidationError} When content length exceeds limit
 */
function validateRequestSize(req, maxSize = DEFAULT_CONFIG.maxBodySize) {
    const contentLength = req.headers['content-length'];
    
    if (contentLength) {
        const size = parseInt(contentLength, 10);
        
        if (isNaN(size) || size < 0) {
            throw new ValidationError(
                'Invalid Content-Length header value',
                400
            );
        }
        
        if (size > maxSize) {
            throw new ValidationError(
                `Request payload size ${size} bytes exceeds maximum allowed size ${maxSize} bytes`,
                413
            );
        }
        
        return {
            isValid: true,
            estimatedSize: size,
            hasContentLength: true
        };
    }
    
    // For chunked encoding or missing Content-Length, we'll validate during data reception
    return {
        isValid: true,
        estimatedSize: 0,
        hasContentLength: false,
        requiresStreaming: true
    };
}

/**
 * Validates and sanitizes URL path to prevent directory traversal attacks
 * 
 * @param {string} urlPath - URL path to validate
 * @param {boolean} strict - Enable strict validation mode
 * @returns {Object} Validation result with isValid and sanitizedPath properties
 * @throws {ValidationError} When path contains suspicious patterns
 */
function validateUrlPath(urlPath, strict = DEFAULT_CONFIG.strictPathValidation) {
    if (!urlPath || typeof urlPath !== 'string') {
        throw new ValidationError('URL path is required and must be a string', 400);
    }
    
    // Parse URL to handle query strings and fragments
    let parsedUrl;
    try {
        parsedUrl = url.parse(urlPath);
    } catch (error) {
        throw new ValidationError('Invalid URL format', 400);
    }
    
    const pathname = parsedUrl.pathname || '/';
    
    // Check for directory traversal patterns
    const dangerousPatterns = [
        /\.\.\//g,  // ../
        /\.\.\\g/,  // ..\
        /\.\./g,    // ..
        /%2e%2e/gi, // URL encoded ..
        /%2f/gi,    // URL encoded /
        /%5c/gi     // URL encoded \
    ];
    
    for (const pattern of dangerousPatterns) {
        if (pattern.test(pathname)) {
            throw new ValidationError(
                'URL path contains suspicious patterns that could indicate directory traversal attempt',
                400
            );
        }
    }
    
    // Additional strict validation
    if (strict) {
        // Reject paths with null bytes
        if (pathname.includes('\0')) {
            throw new ValidationError('URL path contains null bytes', 400);
        }
        
        // Reject excessively long paths
        if (pathname.length > 2048) {
            throw new ValidationError('URL path exceeds maximum length', 414);
        }
        
        // Normalize path and ensure it doesn't escape root
        const normalizedPath = path.posix.normalize(pathname);
        if (normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
            throw new ValidationError('Normalized path attempts to escape root directory', 400);
        }
    }
    
    return {
        isValid: true,
        sanitizedPath: pathname,
        normalizedPath: strict ? path.posix.normalize(pathname) : pathname,
        query: parsedUrl.query,
        fragment: parsedUrl.hash
    };
}

/**
 * Validates request headers for common security issues
 * 
 * @param {Object} headers - HTTP request headers object
 * @returns {Object} Validation result with isValid and validatedHeaders properties
 * @throws {ValidationError} When headers contain suspicious values
 */
function validateRequestHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        throw new ValidationError('Request headers are required', 400);
    }
    
    const validatedHeaders = {};
    
    // Check for excessively long header values
    for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'string' && value.length > 8192) {
            throw new ValidationError(
                `Header '${name}' exceeds maximum length of 8192 characters`,
                400
            );
        }
        
        // Check for null bytes in headers
        if (typeof value === 'string' && value.includes('\0')) {
            throw new ValidationError(
                `Header '${name}' contains null bytes`,
                400
            );
        }
        
        validatedHeaders[name.toLowerCase()] = value;
    }
    
    // Validate Host header (required for HTTP/1.1)
    if (!validatedHeaders.host && !validatedHeaders[':authority']) {
        throw new ValidationError('Host header is required for HTTP/1.1 requests', 400);
    }
    
    return {
        isValid: true,
        validatedHeaders: validatedHeaders
    };
}

/**
 * Creates a request timeout handler for preventing hanging connections
 * 
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Function} Cleanup function to clear the timeout
 */
function createRequestTimeout(req, res, timeout = DEFAULT_CONFIG.requestTimeout) {
    const timeoutId = setTimeout(() => {
        if (!res.headersSent) {
            const error = new TimeoutError('Request timeout exceeded', 408);
            res.statusCode = 408;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: 'Request Timeout',
                message: error.message,
                statusCode: 408,
                timestamp: new Date().toISOString()
            }));
        }
        
        // Force close the connection
        if (req.socket && !req.socket.destroyed) {
            req.socket.destroy();
        }
    }, timeout);
    
    // Clear timeout when request completes
    const cleanup = () => {
        clearTimeout(timeoutId);
    };
    
    req.on('end', cleanup);
    req.on('close', cleanup);
    req.on('error', cleanup);
    
    return cleanup;
}

/**
 * Comprehensive request validation middleware
 * 
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {Object} config - Validation configuration object
 * @returns {Object} Validation result with all validation details
 * @throws {ValidationError} When any validation fails
 */
function validateRequest(req, res, config = {}) {
    const validationConfig = { ...DEFAULT_CONFIG, ...config };
    const validationResult = {
        timestamp: new Date().toISOString(),
        method: null,
        contentType: null,
        size: null,
        path: null,
        headers: null,
        isValid: false
    };
    
    try {
        // Create timeout handler first
        const timeoutCleanup = createRequestTimeout(req, res, validationConfig.requestTimeout);
        
        // 1. Validate HTTP method
        const methodResult = validateHttpMethod(req.method, validationConfig.allowedMethods);
        validationResult.method = methodResult;
        
        // 2. Validate request headers
        const headersResult = validateRequestHeaders(req.headers);
        validationResult.headers = headersResult;
        
        // 3. Validate Content-Type (if applicable)
        let contentTypeResult = { isValid: true, skipValidation: true };
        if (validationConfig.validateContentType) {
            contentTypeResult = validateContentType(
                methodResult.method,
                req.headers['content-type'],
                validationConfig.allowedContentTypes
            );
        }
        validationResult.contentType = contentTypeResult;
        
        // 4. Validate request size
        const sizeResult = validateRequestSize(req, validationConfig.maxBodySize);
        validationResult.size = sizeResult;
        
        // 5. Validate and sanitize URL path
        const pathResult = validateUrlPath(req.url, validationConfig.strictPathValidation);
        validationResult.path = pathResult;
        
        // All validations passed
        validationResult.isValid = true;
        validationResult.timeoutCleanup = timeoutCleanup;
        
        return validationResult;
        
    } catch (error) {
        // Validation failed - prepare error response
        const statusCode = error.statusCode || 400;
        const errorResponse = {
            error: getErrorTypeFromStatusCode(statusCode),
            message: error.message,
            statusCode: statusCode,
            timestamp: new Date().toISOString(),
            path: req.url,
            method: req.method
        };
        
        // Set appropriate response headers
        if (!res.headersSent) {
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            
            // Add specific error headers
            if (statusCode === 405) {
                res.setHeader('Allow', validationConfig.allowedMethods.join(', '));
            }
        }
        
        validationResult.error = error;
        validationResult.errorResponse = errorResponse;
        
        // Re-throw the error for the caller to handle
        throw error;
    }
}

/**
 * Gets the appropriate error type name from HTTP status code
 * 
 * @param {number} statusCode - HTTP status code
 * @returns {string} Error type name
 */
function getErrorTypeFromStatusCode(statusCode) {
    const errorTypes = {
        400: 'Bad Request',
        405: 'Method Not Allowed',
        408: 'Request Timeout',
        413: 'Payload Too Large',
        414: 'URI Too Long',
        415: 'Unsupported Media Type'
    };
    
    return errorTypes[statusCode] || 'Validation Error';
}

/**
 * Express-style middleware wrapper for validation
 * 
 * @param {Object} config - Validation configuration
 * @returns {Function} Middleware function
 */
function createValidationMiddleware(config = {}) {
    return function validationMiddleware(req, res, next) {
        try {
            const result = validateRequest(req, res, config);
            
            // Attach validation result to request object
            req.validation = result;
            
            // Call next middleware or handler
            if (typeof next === 'function') {
                next();
            }
            
            return result;
            
        } catch (error) {
            // Handle validation error
            if (!res.headersSent) {
                const statusCode = error.statusCode || 400;
                const errorResponse = {
                    error: getErrorTypeFromStatusCode(statusCode),
                    message: error.message,
                    statusCode: statusCode,
                    timestamp: new Date().toISOString()
                };
                
                res.statusCode = statusCode;
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('X-Frame-Options', 'DENY');
                res.setHeader('X-XSS-Protection', '1; mode=block');
                
                if (statusCode === 405) {
                    res.setHeader('Allow', (config.allowedMethods || DEFAULT_CONFIG.allowedMethods).join(', '));
                }
                
                res.end(JSON.stringify(errorResponse));
            }
            
            // Don't call next on error
            return null;
        }
    };
}

/**
 * Stream validation for chunked requests without Content-Length
 * 
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {number} maxSize - Maximum allowed size
 * @returns {Promise<boolean>} Promise that resolves when validation completes
 */
function validateRequestStream(req, maxSize = DEFAULT_CONFIG.maxBodySize) {
    return new Promise((resolve, reject) => {
        let totalSize = 0;
        let isValidating = true;
        
        const cleanup = () => {
            isValidating = false;
            req.removeAllListeners('data');
            req.removeAllListeners('end');
            req.removeAllListeners('error');
        };
        
        req.on('data', (chunk) => {
            if (!isValidating) return;
            
            totalSize += chunk.length;
            
            if (totalSize > maxSize) {
                cleanup();
                reject(new ValidationError(
                    `Request payload size ${totalSize} bytes exceeds maximum allowed size ${maxSize} bytes`,
                    413
                ));
            }
        });
        
        req.on('end', () => {
            if (!isValidating) return;
            cleanup();
            resolve(true);
        });
        
        req.on('error', (error) => {
            if (!isValidating) return;
            cleanup();
            reject(error);
        });
        
        // Set a timeout for the stream validation
        setTimeout(() => {
            if (isValidating) {
                cleanup();
                reject(new TimeoutError('Request stream validation timeout', 408));
            }
        }, DEFAULT_CONFIG.requestTimeout);
    });
}

// Export all functions and configuration
module.exports = {
    // Main validation functions
    validateRequest,
    validateHttpMethod,
    validateContentType,
    validateRequestSize,
    validateUrlPath,
    validateRequestHeaders,
    validateRequestStream,
    
    // Middleware and utilities
    createValidationMiddleware,
    createRequestTimeout,
    
    // Configuration
    DEFAULT_CONFIG,
    
    // Error classes (for external use)
    ValidationError,
    TimeoutError,
    
    // Helper functions
    getErrorTypeFromStatusCode
};