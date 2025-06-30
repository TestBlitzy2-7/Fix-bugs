/**
 * Custom Error Handling Module for HTTP Server Robustness
 * 
 * Provides comprehensive error management infrastructure including:
 * - Custom error class hierarchy for precise error classification
 * - Centralized error dispatcher for unified error processing
 * - Structured error response generation with appropriate HTTP status codes
 * - Error logging infrastructure with timestamps and context preservation
 * - Error boundary components to prevent uncaught exceptions from terminating the Node.js process
 * 
 * Part of Feature F-005: Robust Error Handling
 * Zero external dependencies - Node.js built-in modules only
 * 
 * @module lib/errors
 */

'use strict';

const util = require('util');

// =============================================================================
// CUSTOM ERROR CLASS HIERARCHY
// =============================================================================

/**
 * Base application error class that extends the native Error class
 * Provides foundation for all custom error types with enhanced properties
 */
class AppError extends Error {
    /**
     * Create an application error
     * @param {string} message - Error message
     * @param {number} statusCode - HTTP status code
     * @param {string} code - Error code for classification
     * @param {boolean} isOperational - Whether error is operational (expected)
     * @param {Object} context - Additional error context
     */
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true, context = {}) {
        super(message);
        
        // Maintain proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
        
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = isOperational;
        this.context = context;
        this.timestamp = new Date().toISOString();
        
        // Prevent accidental exposure of sensitive information
        this.sanitizedMessage = this.sanitizeMessage(message);
    }
    
    /**
     * Sanitize error message to prevent sensitive information exposure
     * @param {string} message - Original error message
     * @returns {string} Sanitized message safe for client exposure
     */
    sanitizeMessage(message) {
        // Remove potential file paths, internal system details, and stack traces
        return message
            .replace(/\/[^\s]*\/[^\s]*/g, '[PATH_REDACTED]') // Remove file paths
            .replace(/Error:\s*/g, '') // Remove Error: prefix
            .replace(/at\s+[^\n]+/g, '') // Remove stack trace lines
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }
    
    /**
     * Convert error to JSON representation for logging and debugging
     * @returns {Object} JSON representation of the error
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            sanitizedMessage: this.sanitizedMessage,
            statusCode: this.statusCode,
            code: this.code,
            isOperational: this.isOperational,
            timestamp: this.timestamp,
            context: this.context,
            stack: this.stack
        };
    }
}

/**
 * Validation Error - For input validation failures
 * Used when HTTP requests fail validation checks (method, headers, payload, URL)
 */
class ValidationError extends AppError {
    /**
     * Create a validation error
     * @param {string} message - Error message describing validation failure
     * @param {string} field - Field that failed validation
     * @param {*} value - Value that failed validation
     * @param {Object} context - Additional validation context
     */
    constructor(message, field = null, value = null, context = {}) {
        const enhancedContext = {
            ...context,
            field,
            value: value !== null ? String(value).substring(0, 100) : null, // Truncate long values
            validationType: 'input_validation'
        };
        
        super(message, 400, 'VALIDATION_ERROR', true, enhancedContext);
    }
}

/**
 * Timeout Error - For request and operation timeouts
 * Used when operations exceed configured time limits
 */
class TimeoutError extends AppError {
    /**
     * Create a timeout error
     * @param {string} message - Error message describing timeout
     * @param {number} timeout - Timeout value that was exceeded (in milliseconds)
     * @param {string} operation - Operation that timed out
     * @param {Object} context - Additional timeout context
     */
    constructor(message, timeout = 0, operation = 'unknown', context = {}) {
        const enhancedContext = {
            ...context,
            timeout,
            operation,
            timeoutType: 'operation_timeout'
        };
        
        super(message, 408, 'REQUEST_TIMEOUT', true, enhancedContext);
    }
}

/**
 * Shutdown Error - For graceful shutdown related errors
 * Used during server shutdown process when cleanup operations fail
 */
class ShutdownError extends AppError {
    /**
     * Create a shutdown error
     * @param {string} message - Error message describing shutdown issue
     * @param {string} phase - Shutdown phase where error occurred
     * @param {Object} context - Additional shutdown context
     */
    constructor(message, phase = 'unknown', context = {}) {
        const enhancedContext = {
            ...context,
            shutdownPhase: phase,
            shutdownType: 'graceful_shutdown'
        };
        
        super(message, 500, 'SHUTDOWN_ERROR', true, enhancedContext);
    }
}

/**
 * Internal Error - For internal server errors and unexpected failures
 * Used for system-level errors and unexpected exceptions
 */
class InternalError extends AppError {
    /**
     * Create an internal error
     * @param {string} message - Error message describing internal failure
     * @param {Error} originalError - Original error that caused this internal error
     * @param {Object} context - Additional internal error context
     */
    constructor(message, originalError = null, context = {}) {
        const enhancedContext = {
            ...context,
            originalError: originalError ? {
                name: originalError.name,
                message: originalError.message,
                stack: originalError.stack
            } : null,
            internalType: 'system_error'
        };
        
        super(message, 500, 'INTERNAL_ERROR', false, enhancedContext);
        
        // Preserve original error if provided
        if (originalError) {
            this.originalError = originalError;
        }
    }
}

// =============================================================================
// ERROR LOGGING INFRASTRUCTURE
// =============================================================================

/**
 * Error Logger - Provides structured logging with timestamps and context
 */
class ErrorLogger {
    /**
     * Create error logger instance
     * @param {Object} options - Logger configuration options
     */
    constructor(options = {}) {
        this.logLevel = options.logLevel || 'info';
        this.includeStack = options.includeStack !== false;
        this.maxContextLength = options.maxContextLength || 1000;
    }
    
    /**
     * Log error with structured format
     * @param {Error|AppError} error - Error to log
     * @param {Object} request - HTTP request object (optional)
     * @param {Object} additionalContext - Additional logging context
     */
    logError(error, request = null, additionalContext = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: 'error',
            error: {
                name: error.name,
                message: error.message,
                code: error.code || 'UNKNOWN_ERROR',
                statusCode: error.statusCode || 500,
                isOperational: error.isOperational || false
            },
            context: {
                ...additionalContext,
                ...(error.context || {})
            }
        };
        
        // Add request context if available
        if (request) {
            logEntry.request = {
                method: request.method,
                url: request.url,
                headers: this.sanitizeHeaders(request.headers),
                remoteAddress: request.connection?.remoteAddress,
                userAgent: request.headers?.['user-agent']?.substring(0, 200)
            };
        }
        
        // Add stack trace for debugging (but not in production)
        if (this.includeStack && error.stack) {
            logEntry.error.stack = error.stack;
        }
        
        // Truncate large context objects to prevent log overflow
        logEntry.context = this.truncateContext(logEntry.context);
        
        // Output structured log entry
        console.error(JSON.stringify(logEntry, null, 2));
    }
    
    /**
     * Log warning-level messages
     * @param {string} message - Warning message
     * @param {Object} context - Warning context
     */
    logWarning(message, context = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: 'warn',
            message,
            context: this.truncateContext(context)
        };
        
        console.warn(JSON.stringify(logEntry, null, 2));
    }
    
    /**
     * Log info-level messages
     * @param {string} message - Info message
     * @param {Object} context - Info context
     */
    logInfo(message, context = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: 'info',
            message,
            context: this.truncateContext(context)
        };
        
        console.log(JSON.stringify(logEntry, null, 2));
    }
    
    /**
     * Sanitize HTTP headers to remove sensitive information
     * @param {Object} headers - HTTP headers object
     * @returns {Object} Sanitized headers
     */
    sanitizeHeaders(headers = {}) {
        const sanitized = { ...headers };
        
        // Remove or mask sensitive headers
        const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
        sensitiveHeaders.forEach(header => {
            if (sanitized[header]) {
                sanitized[header] = '***REDACTED***';
            }
        });
        
        return sanitized;
    }
    
    /**
     * Truncate context objects to prevent excessive log sizes
     * @param {Object} context - Context object to truncate
     * @returns {Object} Truncated context
     */
    truncateContext(context) {
        const contextStr = JSON.stringify(context);
        if (contextStr.length <= this.maxContextLength) {
            return context;
        }
        
        return {
            ...context,
            _truncated: true,
            _originalLength: contextStr.length,
            _note: 'Context truncated due to size limits'
        };
    }
}

// =============================================================================
// CENTRALIZED ERROR DISPATCHER
// =============================================================================

/**
 * Global error logger instance
 */
const logger = new ErrorLogger({
    logLevel: process.env.LOG_LEVEL || 'info',
    includeStack: process.env.NODE_ENV !== 'production',
    maxContextLength: parseInt(process.env.MAX_CONTEXT_LENGTH) || 1000
});

/**
 * Centralized Error Handler - Unified error processing for all error scenarios
 * Handles error logging, response generation, and error reporting
 * 
 * @param {Error|AppError} error - The error to handle
 * @param {IncomingMessage} req - HTTP request object (optional)
 * @param {ServerResponse} res - HTTP response object (optional)
 * @param {Object} options - Error handling options
 * @returns {Object} Error handling result
 */
function handleError(error, req = null, res = null, options = {}) {
    const startTime = process.hrtime.bigint();
    
    try {
        // Ensure we have a proper error object
        const normalizedError = normalizeError(error);
        
        // Log the error with full context
        logger.logError(normalizedError, req, {
            handlerOptions: options,
            errorHandlingTimestamp: new Date().toISOString()
        });
        
        // Generate structured error response
        const errorResponse = generateErrorResponse(normalizedError, options);
        
        // Send HTTP response if response object is provided
        if (res && !res.headersSent) {
            sendErrorResponse(res, errorResponse);
        }
        
        // Calculate processing time
        const processingTime = Number(process.hrtime.bigint() - startTime) / 1000000; // Convert to milliseconds
        
        // Return error handling result
        return {
            success: true,
            error: normalizedError,
            response: errorResponse,
            processingTimeMs: processingTime,
            timestamp: new Date().toISOString()
        };
        
    } catch (handlingError) {
        // Error occurred while handling the original error
        logger.logError(new InternalError(
            'Error occurred during error handling',
            handlingError,
            { originalError: error }
        ));
        
        // Fallback error response
        const fallbackResponse = {
            error: {
                code: 'ERROR_HANDLER_FAILURE',
                message: 'An error occurred while processing the request',
                statusCode: 500,
                timestamp: new Date().toISOString()
            }
        };
        
        if (res && !res.headersSent) {
            sendErrorResponse(res, fallbackResponse);
        }
        
        return {
            success: false,
            error: handlingError,
            fallbackResponse,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Normalize any error into a proper AppError instance
 * @param {*} error - Error to normalize
 * @returns {AppError} Normalized error
 */
function normalizeError(error) {
    // Already an AppError
    if (error instanceof AppError) {
        return error;
    }
    
    // Native Error object
    if (error instanceof Error) {
        return new InternalError(
            error.message || 'An unexpected error occurred',
            error
        );
    }
    
    // String error
    if (typeof error === 'string') {
        return new InternalError(error);
    }
    
    // Object with error-like properties
    if (error && typeof error === 'object') {
        return new InternalError(
            error.message || 'An error occurred',
            null,
            { originalError: error }
        );
    }
    
    // Unknown error type
    return new InternalError(
        'An unknown error occurred',
        null,
        { originalError: error, errorType: typeof error }
    );
}

/**
 * Generate structured error response for HTTP clients
 * @param {AppError} error - Error to generate response for
 * @param {Object} options - Response generation options
 * @returns {Object} Structured error response
 */
function generateErrorResponse(error, options = {}) {
    const includeStack = options.includeStack || (process.env.NODE_ENV === 'development');
    const includeContext = options.includeContext !== false;
    
    const response = {
        error: {
            code: error.code,
            message: error.sanitizedMessage || error.message,
            statusCode: error.statusCode,
            timestamp: error.timestamp || new Date().toISOString()
        }
    };
    
    // Add debug information in development
    if (includeStack && error.stack) {
        response.error.stack = error.stack;
    }
    
    // Add context information if available and requested
    if (includeContext && error.context && Object.keys(error.context).length > 0) {
        response.error.context = error.context;
    }
    
    // Add request ID if available for tracking
    if (options.requestId) {
        response.error.requestId = options.requestId;
    }
    
    return response;
}

/**
 * Send HTTP error response with appropriate headers
 * @param {ServerResponse} res - HTTP response object
 * @param {Object} errorResponse - Error response to send
 */
function sendErrorResponse(res, errorResponse) {
    const statusCode = errorResponse.error.statusCode || 500;
    
    try {
        // Set response status and headers
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        
        // Add security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        
        // Add error-specific headers
        res.setHeader('X-Error-Code', errorResponse.error.code);
        res.setHeader('X-Error-Timestamp', errorResponse.error.timestamp);
        
        // Send JSON response
        const responseBody = JSON.stringify(errorResponse, null, 2);
        res.end(responseBody);
        
    } catch (responseError) {
        // Fallback if JSON response fails
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error - Unable to generate error response');
    }
}

// =============================================================================
// ERROR BOUNDARY COMPONENTS
// =============================================================================

/**
 * Create error boundary wrapper for protecting functions from uncaught exceptions
 * @param {Function} fn - Function to protect
 * @param {Object} options - Error boundary options
 * @returns {Function} Protected function
 */
function createErrorBoundary(fn, options = {}) {
    const boundaryName = options.name || fn.name || 'anonymous';
    
    return function errorBoundaryWrapper(...args) {
        try {
            const result = fn.apply(this, args);
            
            // Handle promises returned by the function
            if (result && typeof result.then === 'function') {
                return result.catch(promiseError => {
                    const error = new InternalError(
                        `Async error in ${boundaryName}`,
                        promiseError,
                        { boundaryName, args: args.length }
                    );
                    
                    if (options.onError) {
                        options.onError(error);
                    } else {
                        handleError(error);
                    }
                    
                    throw error;
                });
            }
            
            return result;
            
        } catch (syncError) {
            const error = new InternalError(
                `Sync error in ${boundaryName}`,
                syncError,
                { boundaryName, args: args.length }
            );
            
            if (options.onError) {
                options.onError(error);
            } else {
                handleError(error);
            }
            
            throw error;
        }
    };
}

/**
 * Setup global error handlers for the Node.js process
 * Prevents uncaught exceptions from terminating the process
 * @param {Object} options - Global error handler options
 */
function setupGlobalErrorHandlers(options = {}) {
    const exitOnError = options.exitOnError !== false;
    const exitDelay = options.exitDelay || 1000; // 1 second delay before exit
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        const wrappedError = new InternalError(
            'Uncaught Exception - Process may be unstable',
            error,
            { 
                processId: process.pid,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage()
            }
        );
        
        handleError(wrappedError);
        
        if (exitOnError) {
            logger.logWarning('Process exiting due to uncaught exception', {
                exitDelay,
                processId: process.pid
            });
            
            setTimeout(() => {
                process.exit(1);
            }, exitDelay);
        }
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        const wrappedError = new InternalError(
            'Unhandled Promise Rejection',
            reason instanceof Error ? reason : new Error(String(reason)),
            { 
                promise: promise.toString(),
                processId: process.pid,
                uptime: process.uptime()
            }
        );
        
        handleError(wrappedError);
        
        if (exitOnError) {
            logger.logWarning('Process exiting due to unhandled promise rejection', {
                exitDelay,
                processId: process.pid
            });
            
            setTimeout(() => {
                process.exit(1);
            }, exitDelay);
        }
    });
    
    // Handle warning events
    process.on('warning', (warning) => {
        logger.logWarning('Process Warning', {
            name: warning.name,
            message: warning.message,
            stack: warning.stack
        });
    });
    
    logger.logInfo('Global error handlers configured', {
        exitOnError,
        exitDelay,
        processId: process.pid
    });
}

// =============================================================================
// SPECIALIZED ERROR CREATION UTILITIES
// =============================================================================

/**
 * Create validation error for HTTP method validation failures
 * @param {string} method - Invalid HTTP method
 * @param {Array} allowedMethods - List of allowed methods
 * @returns {ValidationError} Method validation error
 */
function createMethodValidationError(method, allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    return new ValidationError(
        `HTTP method '${method}' is not allowed`,
        'method',
        method,
        { 
            allowedMethods,
            statusCode: 405,
            httpErrorType: 'method_not_allowed'
        }
    );
}

/**
 * Create validation error for payload size limit violations
 * @param {number} actualSize - Actual payload size
 * @param {number} maxSize - Maximum allowed size
 * @returns {ValidationError} Payload size validation error
 */
function createPayloadSizeError(actualSize, maxSize) {
    return new ValidationError(
        `Request payload size ${actualSize} bytes exceeds maximum allowed size ${maxSize} bytes`,
        'payload_size',
        actualSize,
        { 
            actualSize,
            maxSize,
            statusCode: 413,
            httpErrorType: 'payload_too_large'
        }
    );
}

/**
 * Create validation error for header validation failures
 * @param {string} header - Header name that failed validation
 * @param {string} value - Header value that failed validation
 * @param {string} reason - Reason for validation failure
 * @returns {ValidationError} Header validation error
 */
function createHeaderValidationError(header, value, reason) {
    return new ValidationError(
        `Header '${header}' validation failed: ${reason}`,
        'header',
        `${header}: ${value}`,
        { 
            header,
            value: String(value).substring(0, 100),
            reason,
            httpErrorType: 'invalid_header'
        }
    );
}

/**
 * Create validation error for URL path validation failures
 * @param {string} path - URL path that failed validation
 * @param {string} reason - Reason for validation failure
 * @returns {ValidationError} Path validation error
 */
function createPathValidationError(path, reason) {
    return new ValidationError(
        `URL path validation failed: ${reason}`,
        'path',
        path,
        { 
            path: String(path).substring(0, 200),
            reason,
            httpErrorType: 'invalid_path'
        }
    );
}

/**
 * Create timeout error for request timeouts
 * @param {number} timeout - Timeout value in milliseconds
 * @param {string} operation - Operation that timed out
 * @returns {TimeoutError} Request timeout error
 */
function createRequestTimeoutError(timeout, operation = 'request_processing') {
    return new TimeoutError(
        `Request timed out after ${timeout}ms`,
        timeout,
        operation,
        { 
            timeoutMs: timeout,
            httpErrorType: 'request_timeout'
        }
    );
}

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    // Error Classes
    AppError,
    ValidationError,
    TimeoutError,
    ShutdownError,
    InternalError,
    
    // Error Logger
    ErrorLogger,
    
    // Central Error Handler
    handleError,
    
    // Error Response Utilities
    generateErrorResponse,
    sendErrorResponse,
    normalizeError,
    
    // Error Boundary Components
    createErrorBoundary,
    setupGlobalErrorHandlers,
    
    // Specialized Error Creation Utilities
    createMethodValidationError,
    createPayloadSizeError,
    createHeaderValidationError,
    createPathValidationError,
    createRequestTimeoutError,
    
    // Logger Instance
    logger
};