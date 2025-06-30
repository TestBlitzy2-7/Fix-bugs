/**
 * Graceful Shutdown Coordinator
 * 
 * Manages server lifecycle through signal handling, connection tracking, resource cleanup,
 * and coordinated shutdown sequences to ensure clean process termination without data loss.
 * 
 * Features:
 * - SIGTERM, SIGINT, and SIGUSR2 signal handlers
 * - Connection tracking and draining with configurable timeouts
 * - Comprehensive resource cleanup for timers and event listeners
 * - Forced termination capabilities for hung connections
 * - Structured logging and error reporting
 * - Integration with custom error handling system
 * 
 * @module ShutdownCoordinator
 */

const EventEmitter = require('events');

/**
 * Exit codes for different shutdown scenarios
 */
const EXIT_CODES = {
    GRACEFUL: 0,           // Normal graceful shutdown
    TIMEOUT: 1,            // Forced shutdown due to timeout
    RESOURCE_CLEANUP_FAILED: 2,  // Critical resource cleanup failure
    SIGNAL_ERROR: 3        // Signal handling error
};

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    gracePeriodMs: 30000,      // 30 seconds grace period
    forceTimeoutMs: 5000,      // 5 seconds for forced termination
    connectionTimeoutMs: 30000, // 30 seconds per connection timeout
    maxConnections: 1000,      // Maximum tracked connections
    logLevel: 'info'           // Logging level
};

/**
 * Shutdown states for state machine management
 */
const SHUTDOWN_STATES = {
    ACTIVE: 'active',
    SHUTDOWN_PENDING: 'shutdown_pending',
    DRAINING: 'draining',
    CLEANUP: 'cleanup',
    TERMINATION: 'termination'
};

/**
 * Graceful Shutdown Coordinator Class
 * 
 * Implements comprehensive server lifecycle management with signal handling,
 * connection tracking, and resource cleanup coordination.
 */
class ShutdownCoordinator extends EventEmitter {
    /**
     * Initialize the shutdown coordinator
     * 
     * @param {Object} options - Configuration options
     * @param {number} [options.gracePeriodMs=30000] - Grace period for connections to complete
     * @param {number} [options.forceTimeoutMs=5000] - Timeout for forced termination
     * @param {number} [options.connectionTimeoutMs=30000] - Individual connection timeout
     * @param {number} [options.maxConnections=1000] - Maximum connections to track
     */
    constructor(options = {}) {
        super();
        
        // Merge configuration with defaults
        this.config = { ...DEFAULT_CONFIG, ...options };
        
        // Initialize state management
        this.state = SHUTDOWN_STATES.ACTIVE;
        this.shutdownInitiated = false;
        this.shutdownStartTime = null;
        
        // Connection tracking registry using Map for efficient lookup
        this.activeConnections = new Map();
        this.connectionCounter = 0;
        this.maxConnectionsReached = false;
        
        // Resource tracking for cleanup
        this.timers = new Set();
        this.intervals = new Set();
        this.eventListeners = new Map(); // Maps event target to listener registry
        
        // Shutdown coordination
        this.server = null;
        this.shutdownCallbacks = [];
        this.resourceCleanupCallbacks = [];
        
        // Signal handlers registry
        this.signalHandlers = new Map();
        
        // Error tracking for diagnostics
        this.shutdownErrors = [];
        
        // Bind methods to preserve context
        this.handleSignal = this.handleSignal.bind(this);
        this.forceShutdown = this.forceShutdown.bind(this);
        this.drainConnections = this.drainConnections.bind(this);
        
        this.log('info', 'Shutdown coordinator initialized', {
            gracePeriod: this.config.gracePeriodMs,
            forceTimeout: this.config.forceTimeoutMs,
            maxConnections: this.config.maxConnections
        });
    }
    
    /**
     * Register an HTTP server for shutdown coordination
     * 
     * @param {http.Server} server - The HTTP server instance to manage
     * @throws {Error} If server is invalid or already registered
     */
    registerServer(server) {
        if (!server || typeof server.close !== 'function') {
            throw new Error('Invalid server instance provided');
        }
        
        if (this.server) {
            throw new Error('Server already registered with shutdown coordinator');
        }
        
        this.server = server;
        
        // Track server connections
        this.setupConnectionTracking(server);
        
        // Set up signal handlers
        this.setupSignalHandlers();
        
        this.log('info', 'Server registered for shutdown coordination', {
            serverType: server.constructor.name
        });
        
        this.emit('server-registered', server);
    }
    
    /**
     * Set up connection tracking for the registered server
     * 
     * @private
     * @param {http.Server} server - The server to track connections for
     */
    setupConnectionTracking(server) {
        // Track new connections
        server.on('connection', (socket) => {
            const connectionId = this.generateConnectionId();
            
            // Check connection limits
            if (this.activeConnections.size >= this.config.maxConnections) {
                if (!this.maxConnectionsReached) {
                    this.log('warn', 'Maximum connections reached', {
                        current: this.activeConnections.size,
                        maximum: this.config.maxConnections
                    });
                    this.maxConnectionsReached = true;
                }
                
                // Close excess connections during normal operation
                if (this.state === SHUTDOWN_STATES.ACTIVE) {
                    socket.destroy();
                    return;
                }
            }
            
            // Create connection metadata
            const connectionInfo = {
                id: connectionId,
                socket: socket,
                startTime: Date.now(),
                remoteAddress: socket.remoteAddress,
                remotePort: socket.remotePort,
                requestCount: 0,
                lastActivity: Date.now()
            };
            
            // Register connection
            this.activeConnections.set(connectionId, connectionInfo);
            
            // Set up connection timeout
            const connectionTimeout = setTimeout(() => {
                this.handleConnectionTimeout(connectionId);
            }, this.config.connectionTimeoutMs);
            
            connectionInfo.timeout = connectionTimeout;
            
            // Handle connection events
            socket.on('close', () => {
                this.removeConnection(connectionId);
            });
            
            socket.on('error', (error) => {
                this.log('warn', 'Connection error', {
                    connectionId,
                    error: error.message
                });
                this.removeConnection(connectionId);
            });
            
            // Track request activity
            socket.on('data', () => {
                if (this.activeConnections.has(connectionId)) {
                    const conn = this.activeConnections.get(connectionId);
                    conn.lastActivity = Date.now();
                    conn.requestCount++;
                }
            });
            
            this.log('debug', 'Connection registered', {
                connectionId,
                totalConnections: this.activeConnections.size,
                remoteAddress: connectionInfo.remoteAddress
            });
            
            this.emit('connection-registered', connectionInfo);
        });
    }
    
    /**
     * Generate unique connection identifier
     * 
     * @private
     * @returns {string} Unique connection ID
     */
    generateConnectionId() {
        return `conn-${Date.now()}-${++this.connectionCounter}`;
    }
    
    /**
     * Remove connection from tracking registry
     * 
     * @private
     * @param {string} connectionId - Connection ID to remove
     */
    removeConnection(connectionId) {
        const connectionInfo = this.activeConnections.get(connectionId);
        if (connectionInfo) {
            // Clear connection timeout
            if (connectionInfo.timeout) {
                clearTimeout(connectionInfo.timeout);
            }
            
            // Remove from registry
            this.activeConnections.delete(connectionId);
            
            // Reset max connections flag if below threshold
            if (this.activeConnections.size < this.config.maxConnections * 0.8) {
                this.maxConnectionsReached = false;
            }
            
            this.log('debug', 'Connection removed', {
                connectionId,
                duration: Date.now() - connectionInfo.startTime,
                requestCount: connectionInfo.requestCount,
                remainingConnections: this.activeConnections.size
            });
            
            this.emit('connection-removed', connectionInfo);
            
            // Check if draining is complete
            if (this.state === SHUTDOWN_STATES.DRAINING && this.activeConnections.size === 0) {
                this.log('info', 'All connections drained successfully');
                this.transitionToCleanup();
            }
        }
    }
    
    /**
     * Handle connection timeout
     * 
     * @private
     * @param {string} connectionId - Connection ID that timed out
     */
    handleConnectionTimeout(connectionId) {
        const connectionInfo = this.activeConnections.get(connectionId);
        if (connectionInfo) {
            this.log('warn', 'Connection timeout, forcing close', {
                connectionId,
                duration: Date.now() - connectionInfo.startTime,
                requestCount: connectionInfo.requestCount
            });
            
            // Force close the socket
            connectionInfo.socket.destroy();
            this.removeConnection(connectionId);
            
            this.emit('connection-timeout', connectionInfo);
        }
    }
    
    /**
     * Set up signal handlers for graceful shutdown
     * 
     * @private
     */
    setupSignalHandlers() {
        const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
        
        signals.forEach(signal => {
            const handler = () => this.handleSignal(signal);
            
            // Store handler reference for cleanup
            this.signalHandlers.set(signal, handler);
            
            process.on(signal, handler);
            
            this.log('debug', `Signal handler registered for ${signal}`);
        });
        
        // Handle uncaught exceptions to trigger graceful shutdown
        process.on('uncaughtException', (error) => {
            this.log('error', 'Uncaught exception, initiating emergency shutdown', {
                error: error.message,
                stack: error.stack
            });
            this.handleSignal('UNCAUGHT_EXCEPTION', error);
        });
        
        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            this.log('error', 'Unhandled promise rejection, initiating emergency shutdown', {
                reason: reason.toString(),
                promise: promise.toString()
            });
            this.handleSignal('UNHANDLED_REJECTION', reason);
        });
    }
    
    /**
     * Handle process signals for graceful shutdown
     * 
     * @private
     * @param {string} signal - The signal received
     * @param {Error} [error] - Optional error for exception signals
     */
    async handleSignal(signal, error = null) {
        if (this.shutdownInitiated) {
            this.log('warn', `Received ${signal} signal during shutdown, ignoring`);
            return;
        }
        
        this.log('info', `Received ${signal} signal, initiating graceful shutdown`, {
            activeConnections: this.activeConnections.size,
            uptime: process.uptime()
        });
        
        this.shutdownInitiated = true;
        this.shutdownStartTime = Date.now();
        this.state = SHUTDOWN_STATES.SHUTDOWN_PENDING;
        
        try {
            // Emit shutdown initiated event
            this.emit('shutdown-initiated', { signal, error });
            
            // Execute shutdown sequence
            await this.executeShutdownSequence(signal, error);
            
        } catch (shutdownError) {
            this.log('error', 'Error during graceful shutdown', {
                signal,
                error: shutdownError.message,
                stack: shutdownError.stack
            });
            
            this.shutdownErrors.push(shutdownError);
            
            // Fall back to forced shutdown
            this.forceShutdown(EXIT_CODES.SIGNAL_ERROR);
        }
    }
    
    /**
     * Execute the complete shutdown sequence
     * 
     * @private
     * @param {string} signal - The signal that triggered shutdown
     * @param {Error} [error] - Optional error for exception signals
     */
    async executeShutdownSequence(signal, error) {
        // Step 1: Stop accepting new connections
        await this.stopAcceptingConnections();
        
        // Step 2: Drain existing connections
        await this.drainConnections();
        
        // Step 3: Execute resource cleanup
        await this.performResourceCleanup();
        
        // Step 4: Execute shutdown callbacks
        await this.executeShutdownCallbacks();
        
        // Step 5: Complete shutdown
        this.completeShutdown(signal, error);
    }
    
    /**
     * Stop the server from accepting new connections
     * 
     * @private
     */
    async stopAcceptingConnections() {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            
            this.log('info', 'Stopping server from accepting new connections');
            
            // Close the server to stop accepting new connections
            this.server.close((error) => {
                if (error) {
                    this.log('warn', 'Error closing server', { error: error.message });
                    this.shutdownErrors.push(error);
                } else {
                    this.log('info', 'Server stopped accepting new connections');
                }
                resolve();
            });
            
            this.emit('server-closed');
        });
    }
    
    /**
     * Drain existing connections within grace period
     * 
     * @private
     */
    async drainConnections() {
        if (this.activeConnections.size === 0) {
            this.log('info', 'No active connections to drain');
            return;
        }
        
        this.log('info', 'Starting connection draining', {
            activeConnections: this.activeConnections.size,
            gracePeriod: this.config.gracePeriodMs
        });
        
        this.state = SHUTDOWN_STATES.DRAINING;
        this.emit('draining-started', { connectionCount: this.activeConnections.size });
        
        return new Promise((resolve) => {
            // Set up grace period timeout
            const graceTimeout = setTimeout(() => {
                this.log('warn', 'Grace period expired, forcing connection termination', {
                    remainingConnections: this.activeConnections.size
                });
                
                this.forceCloseConnections();
                resolve();
            }, this.config.gracePeriodMs);
            
            // Track timeout for cleanup
            this.timers.add(graceTimeout);
            
            // Wait for natural connection completion
            const checkConnections = () => {
                if (this.activeConnections.size === 0) {
                    clearTimeout(graceTimeout);
                    this.timers.delete(graceTimeout);
                    this.log('info', 'All connections drained naturally');
                    resolve();
                }
            };
            
            // Check immediately and set up monitoring
            checkConnections();
            
            // Monitor connection changes
            this.on('connection-removed', checkConnections);
        });
    }
    
    /**
     * Force close all remaining connections
     * 
     * @private
     */
    forceCloseConnections() {
        const connectionsToClose = Array.from(this.activeConnections.values());
        
        this.log('info', 'Force closing connections', {
            count: connectionsToClose.length
        });
        
        connectionsToClose.forEach(connectionInfo => {
            try {
                connectionInfo.socket.destroy();
                this.log('debug', 'Force closed connection', {
                    connectionId: connectionInfo.id,
                    duration: Date.now() - connectionInfo.startTime
                });
            } catch (error) {
                this.log('warn', 'Error force closing connection', {
                    connectionId: connectionInfo.id,
                    error: error.message
                });
                this.shutdownErrors.push(error);
            }
        });
        
        // Clear all connections from registry
        this.activeConnections.clear();
        
        this.emit('connections-force-closed', { count: connectionsToClose.length });
    }
    
    /**
     * Transition to cleanup state
     * 
     * @private
     */
    transitionToCleanup() {
        this.state = SHUTDOWN_STATES.CLEANUP;
        this.log('info', 'Transitioning to cleanup phase');
        this.emit('cleanup-started');
        
        // Perform resource cleanup
        this.performResourceCleanup()
            .then(() => this.executeShutdownCallbacks())
            .then(() => this.completeShutdown())
            .catch((error) => {
                this.log('error', 'Error during cleanup phase', {
                    error: error.message,
                    stack: error.stack
                });
                this.forceShutdown(EXIT_CODES.RESOURCE_CLEANUP_FAILED);
            });
    }
    
    /**
     * Perform comprehensive resource cleanup
     * 
     * @private
     */
    async performResourceCleanup() {
        this.log('info', 'Starting resource cleanup');
        
        try {
            // Clear all timers
            this.timers.forEach(timer => {
                clearTimeout(timer);
            });
            this.timers.clear();
            
            // Clear all intervals
            this.intervals.forEach(interval => {
                clearInterval(interval);
            });
            this.intervals.clear();
            
            // Remove all event listeners
            this.eventListeners.forEach((listeners, target) => {
                listeners.forEach(({ event, handler }) => {
                    try {
                        target.removeListener(event, handler);
                    } catch (error) {
                        this.log('warn', 'Error removing event listener', {
                            event,
                            error: error.message
                        });
                    }
                });
            });
            this.eventListeners.clear();
            
            // Clean up signal handlers
            this.signalHandlers.forEach((handler, signal) => {
                try {
                    process.removeListener(signal, handler);
                } catch (error) {
                    this.log('warn', 'Error removing signal handler', {
                        signal,
                        error: error.message
                    });
                }
            });
            this.signalHandlers.clear();
            
            // Execute custom resource cleanup callbacks
            await Promise.all(this.resourceCleanupCallbacks.map(async (callback) => {
                try {
                    await callback();
                } catch (error) {
                    this.log('warn', 'Error in resource cleanup callback', {
                        error: error.message
                    });
                    this.shutdownErrors.push(error);
                }
            }));
            
            this.log('info', 'Resource cleanup completed', {
                timersCleared: this.timers.size,
                intervalsCleared: this.intervals.size,
                listenersRemoved: this.eventListeners.size
            });
            
            this.emit('cleanup-completed');
            
        } catch (error) {
            this.log('error', 'Critical error during resource cleanup', {
                error: error.message,
                stack: error.stack
            });
            this.shutdownErrors.push(error);
            throw error;
        }
    }
    
    /**
     * Execute registered shutdown callbacks
     * 
     * @private
     */
    async executeShutdownCallbacks() {
        if (this.shutdownCallbacks.length === 0) {
            return;
        }
        
        this.log('info', 'Executing shutdown callbacks', {
            count: this.shutdownCallbacks.length
        });
        
        const results = await Promise.allSettled(
            this.shutdownCallbacks.map(async (callback) => {
                try {
                    await callback();
                } catch (error) {
                    this.log('warn', 'Error in shutdown callback', {
                        error: error.message
                    });
                    this.shutdownErrors.push(error);
                }
            })
        );
        
        const failed = results.filter(result => result.status === 'rejected').length;
        
        this.log('info', 'Shutdown callbacks completed', {
            total: this.shutdownCallbacks.length,
            failed
        });
        
        this.emit('shutdown-callbacks-completed', { total: this.shutdownCallbacks.length, failed });
    }
    
    /**
     * Complete the shutdown process
     * 
     * @private
     * @param {string} [signal] - The signal that triggered shutdown
     * @param {Error} [error] - Optional error for exception signals
     */
    completeShutdown(signal = 'UNKNOWN', error = null) {
        this.state = SHUTDOWN_STATES.TERMINATION;
        
        const shutdownDuration = this.shutdownStartTime ? 
            Date.now() - this.shutdownStartTime : 0;
        
        const shutdownSummary = {
            signal,
            duration: shutdownDuration,
            errorsEncountered: this.shutdownErrors.length,
            finalConnectionCount: this.activeConnections.size
        };
        
        // Determine exit code
        let exitCode = EXIT_CODES.GRACEFUL;
        if (error || this.shutdownErrors.length > 0) {
            exitCode = this.shutdownErrors.some(err => err.name === 'TimeoutError') ?
                EXIT_CODES.TIMEOUT : EXIT_CODES.RESOURCE_CLEANUP_FAILED;
        }
        
        this.log('info', 'Graceful shutdown completed', {
            ...shutdownSummary,
            exitCode
        });
        
        this.emit('shutdown-completed', { ...shutdownSummary, exitCode });
        
        // Final process exit
        process.exit(exitCode);
    }
    
    /**
     * Force immediate shutdown
     * 
     * @private
     * @param {number} exitCode - Exit code for process termination
     */
    forceShutdown(exitCode = EXIT_CODES.TIMEOUT) {
        this.log('warn', 'Forcing immediate shutdown', {
            exitCode,
            activeConnections: this.activeConnections.size,
            shutdownErrors: this.shutdownErrors.length
        });
        
        // Force close all connections
        this.forceCloseConnections();
        
        // Clear all timers and intervals immediately
        this.timers.forEach(timer => clearTimeout(timer));
        this.intervals.forEach(interval => clearInterval(interval));
        
        this.emit('force-shutdown', { exitCode });
        
        // Force exit after brief delay to allow logging
        setTimeout(() => {
            process.exit(exitCode);
        }, 100);
    }
    
    /**
     * Register a callback to execute during shutdown
     * 
     * @param {Function} callback - Async function to execute during shutdown
     */
    onShutdown(callback) {
        if (typeof callback !== 'function') {
            throw new Error('Shutdown callback must be a function');
        }
        
        this.shutdownCallbacks.push(callback);
        
        this.log('debug', 'Shutdown callback registered', {
            totalCallbacks: this.shutdownCallbacks.length
        });
    }
    
    /**
     * Register a callback for resource cleanup
     * 
     * @param {Function} callback - Async function to execute during resource cleanup
     */
    onResourceCleanup(callback) {
        if (typeof callback !== 'function') {
            throw new Error('Resource cleanup callback must be a function');
        }
        
        this.resourceCleanupCallbacks.push(callback);
        
        this.log('debug', 'Resource cleanup callback registered', {
            totalCallbacks: this.resourceCleanupCallbacks.length
        });
    }
    
    /**
     * Track a timer for cleanup
     * 
     * @param {NodeJS.Timeout} timer - Timer to track
     */
    trackTimer(timer) {
        this.timers.add(timer);
        return timer;
    }
    
    /**
     * Track an interval for cleanup
     * 
     * @param {NodeJS.Timeout} interval - Interval to track
     */
    trackInterval(interval) {
        this.intervals.add(interval);
        return interval;
    }
    
    /**
     * Track an event listener for cleanup
     * 
     * @param {EventEmitter} target - Event target
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     */
    trackEventListener(target, event, handler) {
        if (!this.eventListeners.has(target)) {
            this.eventListeners.set(target, []);
        }
        
        this.eventListeners.get(target).push({ event, handler });
        target.on(event, handler);
        
        return handler;
    }
    
    /**
     * Get current shutdown coordinator status
     * 
     * @returns {Object} Current status information
     */
    getStatus() {
        return {
            state: this.state,
            shutdownInitiated: this.shutdownInitiated,
            activeConnections: this.activeConnections.size,
            trackedTimers: this.timers.size,
            trackedIntervals: this.intervals.size,
            trackedListeners: this.eventListeners.size,
            shutdownCallbacks: this.shutdownCallbacks.length,
            resourceCleanupCallbacks: this.resourceCleanupCallbacks.length,
            shutdownErrors: this.shutdownErrors.length,
            uptime: process.uptime(),
            shutdownDuration: this.shutdownStartTime ? 
                Date.now() - this.shutdownStartTime : null
        };
    }
    
    /**
     * Get detailed connection information
     * 
     * @returns {Array} Array of connection information objects
     */
    getConnectionDetails() {
        return Array.from(this.activeConnections.values()).map(conn => ({
            id: conn.id,
            startTime: conn.startTime,
            duration: Date.now() - conn.startTime,
            remoteAddress: conn.remoteAddress,
            remotePort: conn.remotePort,
            requestCount: conn.requestCount,
            lastActivity: conn.lastActivity,
            timeSinceLastActivity: Date.now() - conn.lastActivity
        }));
    }
    
    /**
     * Trigger graceful shutdown programmatically
     * 
     * @param {string} [reason='PROGRAMMATIC'] - Reason for shutdown
     */
    async shutdown(reason = 'PROGRAMMATIC') {
        this.log('info', 'Programmatic shutdown requested', { reason });
        await this.handleSignal(reason);
    }
    
    /**
     * Log messages with structured format
     * 
     * @private
     * @param {string} level - Log level (debug, info, warn, error)
     * @param {string} message - Log message
     * @param {Object} [metadata] - Additional metadata to log
     */
    log(level, message, metadata = {}) {
        if (level === 'debug' && this.config.logLevel !== 'debug') {
            return;
        }
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            component: 'ShutdownCoordinator',
            message,
            state: this.state,
            pid: process.pid,
            ...metadata
        };
        
        const logMessage = `[${logEntry.timestamp}] ${logEntry.level} - ${logEntry.component}: ${message}`;
        
        switch (level) {
            case 'error':
                console.error(logMessage, metadata);
                break;
            case 'warn':
                console.warn(logMessage, metadata);
                break;
            case 'debug':
                console.debug(logMessage, metadata);
                break;
            default:
                console.log(logMessage, metadata);
        }
    }
}

/**
 * Create and configure a shutdown coordinator instance
 * 
 * @param {Object} [options] - Configuration options
 * @returns {ShutdownCoordinator} Configured shutdown coordinator instance
 */
function createShutdownCoordinator(options = {}) {
    return new ShutdownCoordinator(options);
}

module.exports = {
    ShutdownCoordinator,
    createShutdownCoordinator,
    EXIT_CODES,
    SHUTDOWN_STATES,
    DEFAULT_CONFIG
};