console.log("Starting StockApp server........................................................................................");




const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const dgram = require("dgram");
const os = require('os');
const { exec } = require('child_process');
const app = express();
app.use((req, res, next) => {
    // Allows requests from local files (origin 'null') and other devices
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Handle preflight (OPTIONS) requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
const PORT = 54221;
const HOST = process.env.HOST || process.argv[3] || '0.0.0.0'; // 0.0.0.0 listens on all interfaces
const baseDataPath = process.env.USER_DATA_PATH || 
                     path.join(process.env.APPDATA || 
                     (process.platform === 'darwin' ? 
                      process.env.HOME + '/Library/Application Support' : 
                      process.env.HOME + '/.config'), 'stocksalesappdevelopemttype');
const SERVER_NAME = "StockAppServer";
const DISCOVERY_PORT = 41234;
const DISCOVERY_TOKEN = "123456"; // optional PIN
const BROADCAST_INTERVAL = 3000; // every 3 secon
const onlineUsers = new Map();
const geoip = require('geoip-lite')
const PID_FILE = path.join(os.tmpdir(), 'stockapp-server.pid');
const { 
    transporter,
    sendLowStockAlert, 
    sendSmartRestockRecommendations, 
    sendWelcomeEmail, 
    sendLicenseReminderEmail,
    sendVerificationCode,
    sendMonthlyInsightReport
} = require('./emailFunctions');
let sslOptions;
try {
    sslOptions = {
        key: fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem'))
    };
    console.log('🔐 SSL certificates loaded successfully');
} catch (error) {
    console.error('❌ Failed to load SSL certificates:', error.message);
    console.log('⚠️ Server will not start without SSL certificates');
    process.exit(1);
}
const server = https.createServer(sslOptions, app);
const ws = new WebSocket.Server({ server });

const multer = require('multer');
const cron = require('node-cron');
const { log } = require('console');
const SmartScheduler = require('./smartScheduler');


const folderName = 'MEMORY';
const folderPath = path.resolve(baseDataPath, folderName);
const uploadDir = path.join(baseDataPath, 'MEMORY', 'uploads');
const userDataPath = path.join(baseDataPath, 'MEMORY');
const scheduler = new SmartScheduler(baseDataPath);

const isOfflineMode = process.argv.includes('--offline') || 
                     process.env.OFFLINE_MODE === 'true';
const verificationCodes = new Map();
const SCHEDULE_INTERVALS = ['daily', 'every3days', 'weekly'];
let currentScheduleIndex = 0;
let lastEmailSentDate = null;
let schedulerInitialized = false;


function ipToInt(ip) { return ip.split(".").reduce((acc, o) => (acc << 8) + +o, 0) >>> 0; }
function intToIp(int) { return [(int>>>24)&255,(int>>>16)&255,(int>>>8)&255,int&255].join("."); }
function computeBroadcast(ip, mask) {
  const ipInt = ipToInt(ip), maskInt = ipToInt(mask);
  return intToIp((ipInt & maskInt) | (~maskInt >>> 0));
}
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, uniqueName);
  }
});
function ensureLogoInAppData() {
    try {
        console.log("📋 Checking logo file...");
        
        // Source logo path (in your project)
        const sourceLogoPath = path.join(__dirname, 'image', 'logo.jpg');
        const sourceWelcomePath = path.join(__dirname, 'image', 'welcome-icon.png');
        
        // Destination path (in AppData)
        const destImageDir = path.join(baseDataPath, 'MEMORY', 'image');
        const destLogoPath = path.join(destImageDir, 'logo.jpg');
        const destWelcomePath = path.join(destImageDir, 'welcome-icon.png');
        
        // Create the image directory if it doesn't exist
        if (!fs.existsSync(destImageDir)) {
            fs.mkdirSync(destImageDir, { recursive: true });
            console.log(`✅ Created image directory: ${destImageDir}`);
        }
        
        // Check if source logo exists
        if (!fs.existsSync(sourceLogoPath)) {
            console.warn(`⚠️ Source logo not found at: ${sourceLogoPath}`);
            return false;
        }
                if (!fs.existsSync(sourceLogoPath)) {
            console.warn(`⚠️ Source logo not found at: ${sourceLogoPath}`);
            return false;
        }
                if (!fs.existsSync(sourceWelcomePath)) {
            console.warn(`⚠️ Source welcome icon not found at: ${sourceWelcomePath}`);
            return false;
        }
        
        // Copy logo to AppData if it doesn't exist or is different
        if (!fs.existsSync(destLogoPath)) {
            fs.copyFileSync(sourceLogoPath, destLogoPath);
            console.log(`✅ Logo copied to: ${destLogoPath}`);
            return true;
        } else {
            console.log(`✅ Logo already exists at: ${destLogoPath}`);
        }
        
        // Copy welcome icon to AppData if it doesn't exist or is different
        if (!fs.existsSync(destWelcomePath)) {
            fs.copyFileSync(sourceWelcomePath, destWelcomePath);
            console.log(`✅ Welcome icon copied to: ${destWelcomePath}`);
            return true;
        }
        
    } catch (error) {
        console.error("❌ Error ensuring logo in AppData:", error);
        return false;
    }
}
function checkSingleInstance() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = fs.readFileSync(PID_FILE, 'utf8');
            
            // Check if process with that PID is still running
            try {
                process.kill(parseInt(pid), 0);
                console.error('❌ Another StockApp server instance is already running (PID: ' + pid + ')');
                console.error('   If you\'re sure it\'s not running, delete: ' + PID_FILE);
                process.exit(1);
                return false;
            } catch (err) {
                // Process is dead, remove stale PID file
                fs.unlinkSync(PID_FILE);
                console.log('🧹 Removed stale server PID file');
            }
        }
        
        // Write our PID
        fs.writeFileSync(PID_FILE, process.pid.toString());
        console.log(`📝 Server PID file created: ${PID_FILE} (PID: ${process.pid})`);
        
        // Clean up on exit
        process.on('exit', () => {
            try {
                if (fs.existsSync(PID_FILE)) {
                    fs.unlinkSync(PID_FILE);
                    console.log('🧹 Server PID file removed on exit');
                }
            } catch (err) {
                // Ignore cleanup errors
            }
        });
        
        // Handle crashes
        process.on('uncaughtException', (err) => {
            console.error('💥 Server uncaught exception:', err);
            try {
                if (fs.existsSync(PID_FILE)) {
                    fs.unlinkSync(PID_FILE);
                }
            } catch (e) {}
            process.exit(1);
        });
        
        return true;
    } catch (error) {
        console.error('⚠️ Server PID file check failed:', error.message);
        // Continue anyway? Your choice
        return true;
    }
}

const upload = multer({ storage });
function getIfaceBroadcasts() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal && iface.address && iface.netmask) {
        try {
          out.push({ address: iface.address, broadcast: computeBroadcast(iface.address, iface.netmask) });
        } catch {
          out.push({ address: iface.address, broadcast: "255.255.255.255" });
        }
      }
    }
  }
  if (!out.length) out.push({ address: "0.0.0.0", broadcast: "255.255.255.255" });
  return out;
}

// --- UDP Broadcaster ---
try {
  const udp = dgram.createSocket("udp4");
  udp.bind(() => {
    udp.setBroadcast(true);
    const ifaces = getIfaceBroadcasts();
    console.log("📡 UDP discovery active on:", ifaces);

    setInterval(() => {
        const payload = JSON.stringify({
        name: SERVER_NAME,
        ip: getLocalNetworkIP(),
        port: PORT,
        proto: "https", // Changed from "https"
        token: DISCOVERY_TOKEN,
        ts: Date.now(),
        });

      for (const iface of ifaces) {
        udp.send(payload, DISCOVERY_PORT, iface.broadcast, (err) => {
          if (err) console.warn("UDP send error:", err.message);
        });
      }
    }, BROADCAST_INTERVAL);
  });
} catch (err) {
  console.warn("UDP discovery not started:", err.message);
}

// Ensure the folder exists
function ensureFolderExists(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`Created folder: ${dirPath}`);
    } else {
      console.log(`Folder already exists: ${dirPath}`);
    }
  } catch (err) {
    console.error(`Error creating folder ${dirPath}:`, err);
  }
}
ensureFolderExists(folderPath);
app.use('/dist', express.static(path.join(baseDataPath, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));
app.use(express.static(baseDataPath));
// Also serve from root
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));
// ...existing code...
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Serve static files from the current directory
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// Always use the MEMORY folder in your project for data


// File paths for data storage
const USERS_FILE = path.join(userDataPath, 'users.json');
const SALES_FILE = path.join(userDataPath, 'sales.json');
const STOCK_FILE = path.join(userDataPath, 'stock.json');
const STOCK_HISTORY_FILE = path.join(userDataPath, 'stockHistory.json');
const BUSINESS_INFO_FILE = path.join(userDataPath, 'businessInfo.json');
const TARGETS_FILE = path.join(userDataPath, 'targets.json');
const TASKS_FILE = path.join(userDataPath, 'tasks.json');
const SETUP_FILE = path.join(userDataPath, 'setup.json');
const LICENSE_FILE = path.join(userDataPath, 'license_data.json');
const EMAIL_SETTINGS_FILE = path.join(userDataPath, 'emailSettings.json');
if (!fs.existsSync(EMAIL_SETTINGS_FILE)) {
    fs.writeFileSync(EMAIL_SETTINGS_FILE, JSON.stringify({ 
        email: '', 
        smtpUser: 'ifenyiemma9@gmail.com', 
        smtpPass: 'hidasncmjdyqfulf',
         enabled: false 
        }));
}
if (!fs.existsSync(SETUP_FILE)) {
    fs.writeFileSync(SETUP_FILE, JSON.stringify({
        isFirstTime: true,
        completedAt: null,
        businessName: '',
        ownerName: '',
        version: '1.0'
    }));
}


if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');

const CREDIT_SALES_FILE = path.join(userDataPath, 'creditsales.json');
if (!fs.existsSync(CREDIT_SALES_FILE)) {
    fs.writeFileSync(CREDIT_SALES_FILE, JSON.stringify([]));
}
// --- Notification Center API ---
const NTF_FILE = path.join(userDataPath, 'ntf.json');
if (!fs.existsSync(NTF_FILE)) fs.writeFileSync(NTF_FILE, JSON.stringify([]));

// Initialize data files if they don't exist
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: 'admin', password: 'admin123', role: 'administrator' }]));
}
if (!fs.existsSync(SALES_FILE)) {
    fs.writeFileSync(SALES_FILE, JSON.stringify([]));
}
// NEW: Initialize stock.json if it doesn't exist
if (!fs.existsSync(STOCK_FILE)) {
    fs.writeFileSync(STOCK_FILE, JSON.stringify([]));
}
// NEW: Initialize stockHistory.json if it doesn't exist
if (!fs.existsSync(STOCK_HISTORY_FILE)) {
    fs.writeFileSync(STOCK_HISTORY_FILE, JSON.stringify([]));
}

const LOAN_FILE = path.join(userDataPath, 'loan.json');
if (!fs.existsSync(LOAN_FILE)) fs.writeFileSync(LOAN_FILE, JSON.stringify([]));
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
// NEW: Initialize businessInfo.json with default empty object if it doesn't exist
if (!fs.existsSync(BUSINESS_INFO_FILE)) {
    fs.writeFileSync(BUSINESS_INFO_FILE, JSON.stringify({
        name: '',
        shopNumber: '',
        phoneNumberTwo: '',
        address: '',
        emailOrWebsite: '',
        logoData: '',
        socialMediaHandles: '',
        details: ''
    }));
}
if (!fs.existsSync(TARGETS_FILE)) {
    fs.writeFileSync(TARGETS_FILE, JSON.stringify({ weekly: 0, monthly: 0 }));
}
const CUSTOMER_RECEIPTS_FILE = path.join(userDataPath, 'customerreceipts.json');
if (!fs.existsSync(CUSTOMER_RECEIPTS_FILE)) {
    fs.writeFileSync(CUSTOMER_RECEIPTS_FILE, JSON.stringify([]));
}
const DEVICE_BACKUP_DIR = path.join(baseDataPath, 'MEMORY', 'device-backups');
if (!fs.existsSync(DEVICE_BACKUP_DIR)) {
    fs.mkdirSync(DEVICE_BACKUP_DIR, { recursive: true });
}

app.post('/api/device-backup', async (req, res) => {
    try {
        const { deviceId, deviceName, timestamp, data } = req.body;
        if (!deviceId || !data) {
            return res.status(400).json({ error: 'Missing deviceId or data' });
        }

        const safeId = deviceId.replace(/[^a-z0-9_-]/gi, '_');
        const backupDir = DEVICE_BACKUP_DIR;

        // Delete all existing backups for this device
        const files = await fs.promises.readdir(backupDir);
        const deviceBackups = files.filter(f => f.startsWith(safeId) && f.endsWith('.json'));
        for (const file of deviceBackups) {
            await fs.promises.unlink(path.join(backupDir, file));
        }

        // Save the new backup
        const fileName = `${safeId}_${Date.now()}.json`;
        const filePath = path.join(backupDir, fileName);
        await fs.promises.writeFile(filePath, JSON.stringify({
            deviceId,
            deviceName,
            timestamp,
            data
        }, null, 2));

        console.log(`💾 Device backup saved: ${fileName} (previous backups deleted)`);
        res.json({ success: true, file: fileName });
    } catch (error) {
        console.error('❌ Error saving device backup:', error);
        res.status(500).json({ error: 'Failed to save backup' });
    }
});
app.get('/api/device-backup/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const safeId = deviceId.replace(/[^a-z0-9_-]/gi, '_');

        const files = await fs.promises.readdir(DEVICE_BACKUP_DIR);
        // Filter files belonging to this device (those starting with safeId)
        const deviceBackups = files
            .filter(f => f.startsWith(safeId) && f.endsWith('.json'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(DEVICE_BACKUP_DIR, f)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time); // newest first

        if (deviceBackups.length === 0) {
            return res.status(404).json({ error: 'No backup found for this device' });
        }

        const latest = deviceBackups[0].name;
        const backupData = await fs.promises.readFile(path.join(DEVICE_BACKUP_DIR, latest), 'utf8');
        res.json(JSON.parse(backupData));
    } catch (error) {
        console.error('❌ Error retrieving device backup:', error);
        res.status(500).json({ error: 'Failed to retrieve backup' });
    }
});
function loadServerIp() {
    if (fs.existsSync(ipFilePath)) {
        try {
            return JSON.parse(fs.readFileSync(ipFilePath, 'utf-8'));
        } catch (error) {
            console.error('Error parsing serverIp.json:', error);
            return null;
        }
    }
    return null;
}
app.get('/api/network-status', (req, res) => {
  res.json({
    online: !isOfflineMode,
    mode: isOfflineMode ? 'offline' : 'online',
    ip: 'localhost',
    port: PORT,
    hostname: 'localhost',
    timestamp: Date.now()
  });
});

app.get('/api/license-check', (req, res) => {
    try {
        if (fs.existsSync(LICENSE_FILE)) {
            const licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            // Handle array format (history)
            if (Array.isArray(licenseData)) {
                // Find the most recent activation (last element in array)
                const activations = licenseData.filter(item => item.type);
                const latestActivation = activations[activations.length - 1];
                
                if (latestActivation) {
                    const isActive = latestActivation.type && 
                                   (latestActivation.type === 'Monthly' || latestActivation.type === 'Yearly');
                    
                    // Check if license is expired based on nextToactvate
                    const isExpired = checkIfLicenseExpired(latestActivation);
                    
                    return res.json({ 
                        active: isActive && !isExpired,
                        isExpired: isExpired,
                        type: latestActivation.type,
                        activatedAt: latestActivation.activatedAt,
                        nextToactvate: latestActivation.nextToactvate,
                        link: latestActivation.link,
                        currentActivation: latestActivation, // Send full activation object
                        history: licenseData,
                        createdDate: licenseData[0]?.createdDate || new Date().toISOString(),
                        createdTimestamp: licenseData[0]?.createdTimestamp || Date.now().toString()
                    });
                }
            } 
            // Handle old single-object format
            else if (licenseData.type) {
                const isActive = licenseData.type !== 'Trial';
                const isExpired = checkIfLicenseExpired(licenseData);
                
                return res.json({ 
                    active: isActive && !isExpired,
                    isExpired: isExpired,
                    ...licenseData
                });
            }
            
            // No valid activation found
            return res.json({ 
                active: false,
                type: 'Trial',
                status: 'not_activated'
            });
        }
        
        // No file exists
        return res.json({ 
            active: false,
            type: 'Trial',
            status: 'not_activated'
        });
        
    } catch (error) {
        console.error("Error in /api/license-check:", error);
        res.status(500).json({ 
            active: false,
            error: "Failed to read license data"
        });
    }
});

// Add this helper function to server.js
function checkIfLicenseExpired(activation) {
    if (!activation || !activation.nextToactvate) return true;
    
    try {
        const today = new Date();
        const nextDate = new Date(activation.nextToactvate);
        
        // Reset time part for accurate date comparison
        today.setHours(0, 0, 0, 0);
        nextDate.setHours(0, 0, 0, 0);
        
        // If today is on or after the next activation date, license is expired
        return today >= nextDate;
    } catch (error) {
        console.error('Error checking license expiration:', error);
        return true;
    }
}
app.get('/api/license-history', (req, res) => {
    try {
        if (fs.existsSync(LICENSE_FILE)) {
            const licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            // Ensure it's an array
            let history = [];
            if (Array.isArray(licenseData)) {
                history = licenseData;
            } else if (licenseData.type) {
                history = [{
                    status: "initialized",
                    initializedAt: new Date().toISOString(),
                    createdDate: new Date().toISOString(),
                    createdTimestamp: Date.now().toString()
                }, licenseData];
            }
            
            return res.json({ 
                success: true,
                history: history,
                totalActivations: history.filter(item => item.type).length
            });
        }
        
        res.json({ 
            success: true,
            history: [],
            totalActivations: 0
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: "Failed to read license history"
        });
    }
});
app.get('/api/tasks', (req, res) => {
    try {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        res.json(tasks);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load tasks' });
    }
});
// Update in server.js - /api/activate endpoint
app.post('/api/activate', (req, res) => {
    try {
        const { type, code, link } = req.body;
        
        // Validate input
        if (!type || !code || !link) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing required fields: type, code, link" 
            });
        }
        
        // Load existing license data
        let licenseData = [];
        if (fs.existsSync(LICENSE_FILE)) {
            licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            // Ensure it's an array
            if (!Array.isArray(licenseData)) {
                // Convert old format to array
                licenseData = licenseData.type ? 
                    [{
                        status: "initialized",
                        initializedAt: new Date().toISOString(),
                        createdDate: new Date().toISOString(),
                        createdTimestamp: Date.now().toString()
                    }, licenseData] : 
                    [{
                        status: "initialized",
                        initializedAt: new Date().toISOString(),
                        createdDate: new Date().toISOString(),
                        createdTimestamp: Date.now().toString()
                    }];
            }
        } else {
            // Create initial structure
            licenseData = [{
                status: "initialized",
                initializedAt: new Date().toISOString(),
                createdDate: new Date().toISOString(),
                createdTimestamp: Date.now().toString()
            }];
        }
        
        // --- CHECK IF CODE CAN BE REUSED ---
        // Find all previous uses of this exact code
        const previousUses = licenseData.filter(item => 
            item.code && item.code === code
        );
        
        if (previousUses.length > 0) {
            // Get the most recent use of this code
            const lastUse = previousUses[previousUses.length - 1];
            const lastUseDate = new Date(lastUse.activatedAt);
            const now = new Date();
            
            // Calculate years since last use
            const yearsSinceLastUse = (now.getFullYear() - lastUseDate.getFullYear());
            
            // Check if 3 years have passed (can reuse after 3 years)
            if (yearsSinceLastUse < 3) {
                const nextAvailableYear = lastUseDate.getFullYear() + 3;
                return res.status(400).json({
                    success: false,
                    error: `Code ${code} was already used on ${lastUseDate.toLocaleDateString()}. ` +
                           `It can be used again in ${nextAvailableYear}.`
                });
            }
            
            // If 3+ years have passed, allow reuse but log it
            console.log(`⚠️ Code ${code} being reused after ${yearsSinceLastUse} years`);
        }
        
        // --- CALCULATE NEXT CODE DATE ---
        const calculateNextCodeDate = () => {
            const now = new Date();
            if (type === 'Monthly') {
                now.setMonth(now.getMonth() + 1);
            } else if (type === 'Yearly') {
                now.setFullYear(now.getFullYear() + 1);
            }
            return now.toISOString().split('T')[0]; // YYYY-MM-DD format
        };
        
        const calculateCodeReuseDate = () => {
            const now = new Date();
            now.setFullYear(now.getFullYear() + 3); // 3 years from now
            return now.toISOString().split('T')[0];
        };

        const activationData = {
            type: type,
            code: code,
            link: link,
            activatedAt: new Date().toISOString(),
            nextToactvate: calculateNextCodeDate(),
            nextReuseYear: calculateCodeReuseDate(), // When this code can be used again
            isReuse: previousUses.length > 0 // Flag if this is a code reuse
        };

        // Add to history
        licenseData.push(activationData);

        // Save the updated license data
        fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2));
        
        console.log(`📝 License activated: ${type} - ${code}`);
        console.log(`📅 Next monthly/yearly code: ${activationData.nextToactvate}`);
        console.log(`🔄 This code can be reused in: ${activationData.nextReuseYear}`);
        
        res.json({ 
            success: true, 
            message: "License activated successfully",
            currentActivation: activationData,
            isCodeReuse: previousUses.length > 0,
            reuseInfo: previousUses.length > 0 ? 
                `Code reused after ${previousUses.length} previous use(s)` : 
                'First time use of this code'
        });
    } catch (error) {
        console.error("Error in /api/activate:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to save activation" 
        });
    }
});
app.post('/api/check-code-availability', (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ 
                success: false, 
                error: "Code is required" 
            });
        }
        
        if (!fs.existsSync(LICENSE_FILE)) {
            return res.json({
                success: true,
                available: true,
                message: "Code has never been used before",
                canUse: true
            });
        }
        
        const licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        const previousUses = licenseData.filter(item => 
            item.code && item.code === code
        );
        
        if (previousUses.length === 0) {
            return res.json({
                success: true,
                available: true,
                message: "Code has never been used before",
                canUse: true
            });
        }
        
        // Get most recent use
        const lastUse = previousUses[previousUses.length - 1];
        const lastUseDate = new Date(lastUse.activatedAt);
        const now = new Date();
        
        // Calculate if 3 years have passed
        const yearsSinceLastUse = (now.getFullYear() - lastUseDate.getFullYear());
        const canReuse = yearsSinceLastUse >= 3;
        const nextAvailableYear = lastUseDate.getFullYear() + 3;
        
        return res.json({
            success: true,
            available: canReuse,
            canUse: canReuse,
            previousUses: previousUses.length,
            lastUsed: lastUseDate.toLocaleDateString(),
            yearsSinceLastUse: yearsSinceLastUse,
            nextAvailableYear: nextAvailableYear,
            message: canReuse ? 
                `Code can be reused (last used ${yearsSinceLastUse} years ago)` :
                `Code was used on ${lastUseDate.toLocaleDateString()}. `
               
        });
        
    } catch (error) {
        console.error("Error checking code availability:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check code availability" 
        });
    }
});
// Add this endpoint to server.js
app.get('/api/trial-status', (req, res) => {
    try {
        const TRIAL_DAYS = 30; // Match client side
        
        // Load or create license file
        let licenseData = [];
        if (fs.existsSync(LICENSE_FILE)) {
            licenseData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            // If already activated, return that
            if (Array.isArray(licenseData)) {
                const activations = licenseData.filter(item => item.type);
                const latestActivation = activations[activations.length - 1];
                
                if (latestActivation && (latestActivation.type === 'Monthly' || latestActivation.type === 'Yearly')) {
                    return res.json({
                        isTrial: false,
                        isActivated: true,
                        type: latestActivation.type,
                        message: "Already activated"
                    });
                }
            }
        }
        
        // Check trial days
        let installDate = null;
        if (licenseData.length > 0 && licenseData[0].createdTimestamp) {
            installDate = parseInt(licenseData[0].createdTimestamp);
        } else {
            // Create initial entry if needed
            if (!fs.existsSync(LICENSE_FILE)) {
                createLicenseFileWithDate();
                const newData = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
                installDate = parseInt(newData[0].createdTimestamp);
            }
        }
        
        if (installDate) {
            const daysSinceInstall = Math.floor((Date.now() - installDate) / (1000 * 60 * 60 * 24));
            const daysRemaining = TRIAL_DAYS - daysSinceInstall;
            
            return res.json({
                isTrial: true,
                isActivated: false,
                daysRemaining: daysRemaining > 0 ? daysRemaining : 0,
                daysSinceInstall: daysSinceInstall,
                trialDays: TRIAL_DAYS,
                isExpired: daysRemaining <= 0,
                message: daysRemaining > 0 ? 
                    `Trial active: ${daysRemaining} days remaining` : 
                    "Trial period has ended"
            });
        }
        
        res.json({
            isTrial: true,
            isActivated: false,
            daysRemaining: TRIAL_DAYS,
            trialDays: TRIAL_DAYS,
            isExpired: false,
            message: "New trial started"
        });
        
    } catch (error) {
        console.error("Error in /api/trial-status:", error);
        res.status(500).json({ 
            error: "Failed to check trial status",
            isTrial: true,
            isActivated: false
        });
    }
});
// Update in server.js - /api/install-date endpoint
app.get('/api/install-date', (req, res) => {
    try {
        if (fs.existsSync(LICENSE_FILE)) {
            const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            let installDate, createdDate;

            // FIX: Check if data is an array (History format) or an object (Old format)
            if (Array.isArray(data)) {
                // Use the first entry (initialization entry) for the install date
                installDate = data[0].createdTimestamp;
                createdDate = data[0].createdDate;
            } else {
                installDate = data.createdTimestamp;
                createdDate = data.createdDate;
            }
            
            // Ensure we return a valid numeric string
            res.json({ 
                installDate: installDate || Date.now().toString(),
                createdDate: createdDate || new Date().toISOString(),
                hasLicenseFile: true
            });
        } else {
            // Create a new license file if none exists
            const trialData = { type: 'Trial', status: 'trial_active' };
            const createdData = createLicenseFileWithDate(trialData);
            
            // Return the first element of the array we just created
            res.json({ 
                installDate: createdData[0].createdTimestamp,
                createdDate: createdData[0].createdDate,
                hasLicenseFile: true
            });
        }
    } catch (error) {
        console.error("Error in /api/install-date:", error);
        res.status(500).json({ error: "Failed to get installation date" });
    }
});
app.post('/api/license-reset', (req, res) => {
    if (fs.existsSync(LICENSE_FILE)) {
        fs.unlinkSync(LICENSE_FILE);
    }
    res.json({ success: true, message: "License reset" });
});
const EMAIL_SCHEDULE_FILE = path.join(userDataPath, 'emailSchedule.json');

// --- 1. AUTOMATIC STARTUP (PRODUCTION) ---
function enableAutoStart() {
    if (process.platform !== 'win32') return;

    const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    // Change extension to .vbs
    const shortcutPath = path.join(startupDir, 'StockAppServer.vbs');

    if (!fs.existsSync(shortcutPath)) {
        const vbsContent = 
            `Set WshShell = CreateObject("WScript.Shell")\n` +
            `WshShell.Run "node ""${path.resolve(__filename)}""", 0, False`;

        try {
            fs.writeFileSync(shortcutPath, vbsContent);
            console.log("🚀 Silent Windows Startup enabled.");
        } catch (err) {
            console.warn("Could not setup silent auto-start:", err.message);
        }
    }
}

// --- 2. AUTOMATIC EMAIL CHECKER ---
// --- 2. AUTOMATIC EMAIL CHECKER ---
async function checkAndSendScheduledEmails() {
    try {
        if (!fs.existsSync(EMAIL_SCHEDULE_FILE)) return;

        const schedule = JSON.parse(fs.readFileSync(EMAIL_SCHEDULE_FILE, 'utf8'));
        
        // Critical: The "OFF" switch check
        if (!schedule.enabled || !schedule.email) {
            console.log("[Scheduler] Emails are currently turned OFF.");
            return;
        }

        const now = new Date();
        const lastSent = schedule.lastSent ? new Date(schedule.lastSent) : new Date(0);
        const diffInHours = (now - lastSent) / (1000 * 60 * 60);

        let shouldSend = false;
        if (schedule.frequency === 'daily' && diffInHours >= 24) shouldSend = true;
        else if (schedule.frequency === 'every3days' && diffInHours >= 72) shouldSend = true;
        else if (schedule.frequency === 'weekly' && diffInHours >= 168) shouldSend = true;

        if (shouldSend) {
            console.log(`[Scheduler] Sending ${schedule.frequency} email...`);
            
            // ✅ FIX: Get stock data instead of passing email string
            const stock = readData(STOCK_FILE);
            const sales = readData(SALES_FILE);
            
            const lowStockItems = stock.filter(item => 
                item.quantity <= 3 && item.hasBeenSold === true
            );
            
            // Now pass the actual items to the email function
            if (lowStockItems.length > 0) {
                await sendLowStockAlert(lowStockItems);
            }
            
            await sendSmartRestockRecommendations(stock, sales);

            schedule.lastSent = now.toISOString();
            fs.writeFileSync(EMAIL_SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
            console.log("[Scheduler] Emails sent successfully");
        }
    } catch (error) {
        console.error("Scheduler Error:", error);
    }
}


// Add a new task
app.post('/api/tasks', express.json(), (req, res) => {
    try {
        const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        const newTask = req.body;
        tasks.push(newTask);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
        broadcast({ type: 'new-task', task: newTask });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save task' });
    }
});
app.put('/api/tasks/:id/complete', (req, res) => {
    const taskId = parseInt(req.params.id, 10);
    let tasks = readData(TASKS_FILE);

    const taskIndex = tasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
        return res.status(404).json({ message: 'Task not found' });
    }

    // Update the status
    tasks[taskIndex].status = 'completed';
    tasks[taskIndex].completedAt = new Date().toISOString();

    if (!writeData(TASKS_FILE, tasks)) {
        return res.status(500).json({ message: 'Failed to save task' });
    }
    broadcast({ type: 'task-updated', task: tasks[taskIndex] });

    res.json({ message: 'Task completed successfully', task: tasks[taskIndex] });
});

// GET all customer receipts (for filtering and listing)
app.get('/api/customer-receipts', (req, res) => {
    try {
        const receipts = readData(CUSTOMER_RECEIPTS_FILE) || [];
        res.json(receipts);
    } catch (e) {
        console.error('Failed to fetch customer receipts:', e);
        res.status(500).json({ error: 'Failed to fetch customer receipts' });
    }
});

// GET specific customer receipt by ID
app.get('/api/customer-receipts/:id', (req, res) => {
    try {
        const receipts = readData(CUSTOMER_RECEIPTS_FILE) || [];
        const receipt = receipts.find(r => String(r.receiptId) === String(req.params.id));
        if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

        res.json(receipt);
    } catch (e) {
        console.error('Failed to fetch receipt:', e);
        res.status(500).json({ error: 'Failed to fetch receipt' });
    }
});

// POST create new customer receipt
app.post('/api/customer-receipts', (req, res) => {
    try {
        const receipts = readData(CUSTOMER_RECEIPTS_FILE) || [];
        
        // Check if receipt already exists
        const existingReceipt = receipts.find(r => String(r.receiptId) === String(req.body.receiptId));
        if (existingReceipt) {
            return res.status(400).json({ error: 'Receipt with this ID already exists' });
        }
        
        // Add timestamp if not provided
        const receiptData = {
            ...req.body,
            createdAt: req.body.createdAt || new Date().toLocaleString(),
            updatedAt: new Date().toISOString()
        };
        
        receipts.push(receiptData);
        const success = writeData(CUSTOMER_RECEIPTS_FILE, receipts);
        if (!success) return res.status(500).json({ error: 'Failed to save receipt data' });
        
        res.json({ success: true, receipt: receiptData });
    } catch (e) {
        console.error('Failed to save customer receipt:', e);
        res.status(500).json({ error: 'Failed to save customer receipt' });
    }
});

// PUT update existing customer receipt
app.put('/api/customer-receipts/:id', (req, res) => {
    try {
        const receipts = readData(CUSTOMER_RECEIPTS_FILE) || [];
        const idx = receipts.findIndex(r => String(r.receiptId) === String(req.params.id));
        if (idx === -1) {
            return res.status(404).json({ error: 'Receipt not found' });
        }
        
        // Merge updates into existing receipt (keep other fields)
        receipts[idx] = { 
            ...receipts[idx], 
            ...req.body,
            updatedAt: new Date().toISOString()
        };
        
        const success = writeData(CUSTOMER_RECEIPTS_FILE, receipts);
        if (!success) return res.status(500).json({ error: 'Failed to write receipt data' });
        
        res.json({ success: true, receipt: receipts[idx] });
    } catch (e) {
        console.error('Failed to update customer receipt:', e);
        res.status(500).json({ error: 'Failed to update customer receipt' });
    }
});

// DELETE customer receipt
app.delete('/api/customer-receipts/:id', (req, res) => {
    try {
        const receipts = readData(CUSTOMER_RECEIPTS_FILE) || [];
        const filteredReceipts = receipts.filter(r => String(r.receiptId) !== String(req.params.id));
        
        if (filteredReceipts.length === receipts.length) {
            return res.status(404).json({ error: 'Receipt not found' });
        }
        
        const success = writeData(CUSTOMER_RECEIPTS_FILE, filteredReceipts);
        if (!success) return res.status(500).json({ error: 'Failed to delete receipt' });
        
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to delete customer receipt:', e);
        res.status(500).json({ error: 'Failed to delete customer receipt' });
    }
});
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ url: imageUrl });
});
app.post('/api/convert-imageData-to-url', async (req, res) => {
  try {
    const stockFile = path.join(baseDataPath, 'MEMORY', 'stock.json');
    const uploadDir = path.join(baseDataPath, 'MEMORY', 'uploads');

    // Ensure upload folder exists
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // Load stock file
    let stockData = JSON.parse(fs.readFileSync(stockFile, 'utf8'));

    let convertedCount = 0;

    // Loop through stock items
    stockData = stockData.map(item => {
      if (item.imageData && item.imageData.startsWith('data:image')) {
        try {
          // Extract base64 content
          const base64Data = item.imageData.split(';base64,').pop();
          const imageBuffer = Buffer.from(base64Data, 'base64');

          // Unique filename
          const filename = `converted_${Date.now()}_${Math.floor(Math.random()*9999)}.png`;
          const filePath = path.join(uploadDir, filename);

          // Write PNG file
          fs.writeFileSync(filePath, imageBuffer);

          // Update item
          item.imageUrl = `/uploads/${filename}`;
          delete item.imageData;
          convertedCount++;
        } catch (err) {
          console.error('Failed to convert image for item:', item.name, err);
        }
      }
      return item;
    });

    // Save updated stock file
    fs.writeFileSync(stockFile, JSON.stringify(stockData, null, 2));

    res.json({
      success: true,
      message: `Converted ${convertedCount} images to PNGs and cleaned imageData.`,
      convertedCount
    });
  } catch (err) {
    console.error('Error converting imageData to PNG:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/api/convert-single-image', async (req, res) => {
  try {
    const { id } = req.body; // item id or name

    const stockFile = path.join(baseDataPath, 'MEMORY', 'stock.json');
    const uploadDir = path.join(baseDataPath, 'MEMORY', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    let stockData = JSON.parse(fs.readFileSync(stockFile, 'utf8'));
    const item = stockData.find(it => it.id === id || it.name === id);

    if (!item) {
      return res.status(404).json({ success: false, error: 'Item not found.' });
    }

    if (!item.imageData) {
      return res.json({ success: false, message: 'No imageData for this item.' });
    }

    // Convert base64 → PNG
    const base64Data = item.imageData.split(';base64,').pop();
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const filename = `converted_${Date.now()}_${Math.floor(Math.random()*9999)}.png`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, imageBuffer);

    item.imageUrl = `/uploads/${filename}`;
    delete item.imageData;

    // Save back
    fs.writeFileSync(stockFile, JSON.stringify(stockData, null, 2));

    res.json({ success: true, message: 'Converted successfully.', url: item.imageUrl });
  } catch (err) {
    console.error('Error converting image:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Add this route to your Express Server file
app.put('/api/users/:username', (req, res) => {
    const targetUsername = decodeURIComponent(req.params.username);
    const updatedData = req.body;
    const usersPath = path.join(folderPath, 'users.json');

    try {
        if (!fs.existsSync(usersPath)) {
            return res.status(404).json({ error: "Database file not found" });
        }

        let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const index = users.findIndex(u => u.username === targetUsername);

        if (index === -1) {
            return res.status(404).json({ error: "User not found in database" });
        }

        // Update the user data while preserving fields not sent in the request
        users[index] = { ...users[index], ...updatedData };
        
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        
        console.log(`✅ Updated user: ${targetUsername}`);
        res.json({ success: true, user: users[index] });
    } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});
app.get('/api/setup-status', (req, res) => {
    try {
        const setup = readData(SETUP_FILE);
        res.json(setup);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read setup status' });
    }
});

app.get('/api/email-schedule-status', (req, res) => {
    try {
        const SCHEDULE_FILE = path.join(userDataPath, 'emailSchedule.json');
        const LOG_FILE = path.join(userDataPath, 'emailScheduleLog.json');
        const SETUP_FILE = path.join(userDataPath, 'setup.json');
        const SETTINGS_FILE = path.join(userDataPath, 'emailSettings.json');

        // 1. Check Setup
        let setupComplete = false;
        if (fs.existsSync(SETUP_FILE)) {
            const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
            setupComplete = !setup.isFirstTime && setup.completedAt;
        }

        // 2. Load Schedule Config
        let scheduleData = { frequency: 'daily', enabled: false };
        if (fs.existsSync(SCHEDULE_FILE)) {
            scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        }

        // 3. Find THE LATEST email date
        let lastEmailISO = null;
        if (fs.existsSync(LOG_FILE)) {
            const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
            const timestamps = [];
            Object.values(log).forEach(day => {
                if (day.manualSend?.timestamp) timestamps.push(new Date(day.manualSend.timestamp));
                if (day.autoSend?.timestamp) timestamps.push(new Date(day.autoSend.timestamp));
            });
            if (timestamps.length > 0) {
                lastEmailISO = new Date(Math.max(...timestamps)).toISOString();
            }
        }

        // FIX: Load actual alert settings from emailSettings.json
        let alertSettings = { lowStock: false, restock: false };
        if (fs.existsSync(SETTINGS_FILE)) {
            try {
                const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
                if (settings.alertTypes) {
                    alertSettings.lowStock = settings.alertTypes.lowStock === true;
                    alertSettings.restock = settings.alertTypes.restock === true;
                }
            } catch (e) {
                console.error('Error parsing email settings:', e);
            }
        }

        // 4. Send response with correct alert settings
        res.json({
            setupComplete,
            isEnabled: scheduleData.enabled === true, 
            lastEmailSentDate: lastEmailISO,
            canSendEmails: setupComplete,
            frequency: scheduleData.frequency || 'daily',
            lowStockEnabled: alertSettings.lowStock,  // This should now be correct
            restockEnabled: alertSettings.restock      // This should now be correct
        });

    } catch (error) {
        console.error('Status Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            lowStockEnabled: false,
            restockEnabled: false 
        });
    }
});
// API to schedule emails
app.post('/api/schedule-emails', (req, res) => {
    // 1. Get all variables from the body
    const { schedule, frequency, enabled, email } = req.body;
    const targetFrequency = frequency || schedule; // Handle both variable names from UI

    try {
        const SCHEDULE_FILE = path.join(userDataPath, 'emailSchedule.json');
        
        // 2. Load existing data or start fresh
        let scheduleData = { frequency: 'daily', enabled: false, lastSent: null };
        if (fs.existsSync(SCHEDULE_FILE)) {
            scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        }

        // 3. Update only the fields that were actually sent
        if (targetFrequency) scheduleData.frequency = targetFrequency;
        if (enabled !== undefined) scheduleData.enabled = enabled;
        if (email) scheduleData.email = email;
        
        scheduleData.lastUpdated = new Date().toISOString();

        // 4. Save the config
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));

        // 5. LOG the change (Optional)
        const LOG_FILE = path.join(userDataPath, 'emailScheduleLog.json');
        let log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : {};
        const today = new Date().toISOString().split('T')[0];
        
        log[today] = log[today] || {};
        log[today].lastUpdate = scheduleData.lastUpdated;
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

        // 6. RETURN exactly once
        return res.json({ 
            success: true, 
            message: "Schedule updated successfully",
            schedule: scheduleData 
        });

    } catch (error) {
        console.error("Save error:", error);
        // Use return here too to prevent further execution
        return res.status(500).json({ 
            success: false, 
            message: error.message || 'Failed to schedule emails' 
        });
    }
});

// API to send test email
app.post('/api/send-test-email', async (req, res) => {
    try {
        // Check if email settings exist
        let targetEmail = 'ifenyiemma9@gmail.com';
        if (fs.existsSync(EMAIL_SETTINGS_FILE)) {
            const settings = JSON.parse(fs.readFileSync(EMAIL_SETTINGS_FILE, 'utf8'));
            if (settings.email) {
                targetEmail = settings.email;
            }
        }
        
        // Send test email
        await transporter.sendMail({
            from: '"StockApp Test" <ifenyiemma9@gmail.com>',
            to: targetEmail,
            subject: '📧 StockApp Test Email',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #2563eb;">✅ Test Email Successful!</h2>
                    <p>This is a test email from your StockApp system.</p>
                    <p>If you're receiving this, your email configuration is working correctly.</p>
                    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                    <p style="color: #6b7280; font-size: 14px;">
                        Server: ${os.hostname()}<br>
                        Time: ${new Date().toLocaleString()}<br>
                        System: StockApp Inventory Management
                    </p>
                </div>
            `
        });
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully' 
        });
    } catch (error) {
        console.error('Test email error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send test email' 
        });
    }
});

// API to send emails immediately
app.post('/api/send-emails-now', async (req, res) => {
    try {
        if (!isSetupComplete()) {
            return res.status(400).json({ 
                success: false, 
                message: 'Setup not complete. Complete setup first.' 
            });
        }
        
        // Read data
        const stock = readData(STOCK_FILE);
        const sales = readData(SALES_FILE);
        
        // 1. Send low stock alerts
        const lowStockItems = stock.filter(item => 
            item.quantity <= 3 && item.hasBeenSold === true
        );
        
        if (lowStockItems.length > 0) {
            await sendLowStockAlert(lowStockItems);
        }
        
        // 2. Send smart restock recommendations
        await sendSmartRestockRecommendations(stock, sales);
        
        // Log the manual send
        const LOG_FILE = path.join(userDataPath, 'emailScheduleLog.json');
        let log = {};
        if (fs.existsSync(LOG_FILE)) {
            log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
        
        const today = new Date().toISOString().split('T')[0];
        log[today] = log[today] || {};
        log[today].manualSend = {
            timestamp: new Date().toISOString(),
            lowStockItems: lowStockItems.length
        };
        
        fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
        
        res.json({ 
            success: true, 
            message: 'Emails sent successfully',
            lowStockAlerts: lowStockItems.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Send emails now error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send emails' 
        });
    }
});

// API to test email settings
app.post('/api/test-email-settings', async (req, res) => {
    try {
        const { email } = req.body;
        
        // Update settings with test email
        const settings = {
            email: email,
            enabled: true,
            testMode: true
        };
        
        fs.writeFileSync(EMAIL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
        
        // Send test email to this address
        await transporter.sendMail({
            from: '"StockApp Configuration Test" <ifenyiemma9@gmail.com>',
            to: email,
            subject: '🔧 StockApp Configuration Test',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #2563eb;">⚙️ Email Configuration Test</h2>
                    <p>This email confirms that your StockApp email settings are configured correctly.</p>
                    <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 15px 0;">
                        <p><strong>Email Address:</strong> ${email}</p>
                        <p><strong>Test Time:</strong> ${new Date().toLocaleString()}</p>
                    </div>
                    <p>You will now receive automated inventory alerts at this address.</p>
                </div>
            `
        });
        
        res.json({ 
            success: true, 
            message: 'Test email sent to ' + email 
        });
    } catch (error) {
        console.error('Email settings test error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send test email' 
        });
    }
});

// API to toggle email scheduling
app.post('/api/toggle-email-schedule', (req, res) => {
    try {
        const { paused } = req.body;
        
        const SCHEDULE_FILE = path.join(userDataPath, 'emailSchedule.json');
        let scheduleData = { enabled: true };
        
        if (fs.existsSync(SCHEDULE_FILE)) {
            scheduleData = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        }
        
        scheduleData.enabled = !paused;
        scheduleData.lastUpdate = new Date().toISOString();
        
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleData, null, 2));
        
        res.json({ 
            success: true, 
            enabled: scheduleData.enabled,
            message: paused ? 'Email scheduling resumed' : 'Email scheduling paused'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to toggle schedule' 
        });
    }
});
// POST to mark setup as complete
app.post('/api/setup-complete', (req, res) => {
    try {
        const { businessName, ownerName } = req.body;
        const setup = {
            isFirstTime: false,
            completedAt: new Date().toISOString(),
            businessName: businessName || '',
            ownerName: ownerName || '',
            version: '1.0'
        };
        
        const success = writeData(SETUP_FILE, setup);
        
        if (success) {
            res.json({ success: true, message: 'Setup marked as complete' });
        } else {
            res.status(500).json({ error: 'Failed to save setup status' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to update setup status' });
    }
});

app.post('/complete-setup', (req, res) => {
  const { businessName, ownerName } = req.body;

  const setupData = {
    isFirstTime: false,
    completedAt: new Date().toISOString(),
    businessName,
    ownerName,
    version: "1.0"
  };


  fs.writeFileSync(SETUP_FILE, JSON.stringify(setupData, null, 2));

  res.json({ success: true });
});

app.post('/api/convert-admin-images', async (req, res) => {
    try {
        const users = readData(USERS_FILE);
        const uploadDir = path.join(baseDataPath, 'MEMORY', 'uploads');
        
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        let convertedCount = 0;

        // Loop through users
        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            
            // Check if photo is base64
            if (user.photo && user.photo.startsWith('data:image')) {
                try {
                    // Extract base64 content
                    const base64Data = user.photo.split(';base64,').pop();
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                    // Generate unique filename
                    const filename = `admin_${Date.now()}_${Math.floor(Math.random()*9999)}_${user.username}.png`;
                    const filePath = path.join(uploadDir, filename);
                    
                    // Write PNG file
                    fs.writeFileSync(filePath, imageBuffer);
                    
                    // Update user photo to URL
                    users[i].photo = `/uploads/${filename}`;
                    convertedCount++;
                    
                } catch (err) {
                    console.error('Failed to convert image for user:', user.username, err);
                    // Set default image if conversion fails
                    users[i].photo = 'image/THE ADMIN.png';
                }
            }
        }

        // Save updated users
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

        res.json({
            success: true,
            message: `Converted ${convertedCount} admin images to URLs`,
            convertedCount
        });
    } catch (err) {
        console.error('Error converting admin images:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper function to read data from a file
function readData(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        // Return appropriate default based on file type
        if (filePath === USERS_FILE || filePath === SALES_FILE || filePath === STOCK_FILE || filePath === STOCK_HISTORY_FILE || filePath === NTF_FILE) {
            return [];
        } else if (filePath === BUSINESS_INFO_FILE) {
            return {
                name: '',
                shopNumber: '',
                phoneNumberTwo: '',
                address: '',
                emailOrWebsite: '',
                logoData: '',
                socialMediaHandles: '',
                details: ''
            };
        } else if (filePath === TARGETS_FILE) {
            return { weekly: 0, monthly: 0 };
        }
        return null; // Fallback
    }
}

// Helper function to write data to a file
function writeData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Error writing file ${filePath}:`, error);
        return false;
    }
}

// Broadcast to all connected clients
function broadcast(data) {
    ws.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// NEW: Function to broadcast the current list of online users and their roles
function broadcastOnlineUsers() {
    const allUsers = readData(USERS_FILE); // Get all users from your users.json
    const onlineUsernames = new Set(Array.from(onlineUsers.keys())); // Get usernames of currently online users

    const usersWithStatus = allUsers.map(user => ({
        username: user.username,
        role: user.role,
        isOnline: onlineUsernames.has(user.username) // Check if this user is in the online set
    }));

    // Broadcast the complete list of users with their online status
    broadcast({ type: 'user-list-update', users: usersWithStatus });
}


// API endpoint to get all users

// GET targets
app.get('/api/targets', (req, res) => {
    fs.readFile(TARGETS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read targets' });
        res.json(JSON.parse(data));
    });
});
app.get('/api/ping', (req, res) => {
    // Send a simple success response
    res.status(200).send('Pong');
});

// Delete all sales
app.delete('/api/sales', (req, res) => {
    try {
        fs.writeFileSync(SALES_FILE, JSON.stringify([]));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete sales' });
    }
});

// Delete all stock
app.delete('/api/stock', (req, res) => {
    try {
        fs.writeFileSync(STOCK_FILE, JSON.stringify([]));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete stock' });
    }
});

// Delete all stock history
app.delete('/api/stock-history', (req, res) => {
    try {
        fs.writeFileSync(STOCK_HISTORY_FILE, JSON.stringify([]));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete stock history' });
    }
});

// Delete all credit sales
app.delete('/api/credit-sales', (req, res) => {
    try {
        fs.writeFileSync(CREDIT_SALES_FILE, JSON.stringify([]));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete credit sales' });
    }
});

// Delete business info (reset to default)
app.delete('/api/business-info', (req, res) => {
    try {
        fs.writeFileSync(BUSINESS_INFO_FILE, JSON.stringify({
            name: '',
            shopNumber: '',
            phoneNumberTwo: '',
            address: '',
            emailOrWebsite: '',
            logoData: '',
            socialMediaHandles: '',
            details: ''
        }));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete business info' });
    }
});
// POST targets (update)
app.post('/api/targets', (req, res) => {
    const { weekly, monthly } = req.body;
    const newTargets = {
        weekly: Number(weekly) || 0,
        monthly: Number(monthly) || 0
    };
    fs.writeFile(TARGETS_FILE, JSON.stringify(newTargets), err => {
        if (err) return res.status(500).json({ error: 'Failed to save targets' });
        res.json({ success: true, ...newTargets });
    });
});

app.get('/api/users', (req, res) => {
    try {
        const users = readData(USERS_FILE);
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/users', (req, res) => {
    try {
        const newUser = req.body;
        const users = readData(USERS_FILE);
        
        // Check if username already exists
        if (users.some(u => u.username.toLowerCase() === newUser.username.toLowerCase())) {
            return res.status(409).json({ error: 'Username already exists' });
        }
        
        // Add default fields if missing
        if (!newUser.role) newUser.role = 'sales';
        if (!newUser.photo) newUser.photo = 'image/THE ADMIN.png';
        
        // Add creation timestamp
        newUser.createdAt = new Date().toISOString();
        newUser.updatedAt = new Date().toISOString();
        
        users.push(newUser);
        const success = writeData(USERS_FILE, users);

        if (!success) {
            return res.status(500).json({ error: 'Failed to save user' });
        }

        console.log(`✅ New user added: ${newUser.username} (${newUser.role})`);
        
        // Broadcast user addition
        broadcast({ 
            type: 'user-added', 
            user: newUser 
        });

        res.status(201).json({ 
            success: true, 
            message: 'User added successfully', 
            user: newUser 
        });
    } catch (error) {
        console.error('Error adding user:', error);
        res.status(500).json({ error: 'Failed to add user: ' + error.message });
    }
});
app.put('/api/users', (req, res) => {
    try {
        const users = req.body;
        
        // Ensure main admin is always present
        const hasMainAdmin = users.some(u => u.username === 'admin' && u.password === 'admin123' && u.role === 'administrator');
        if (!hasMainAdmin) {
            return res.status(403).json({ error: 'Main admin account cannot be removed.' });
        }
        
        // Write to the correct USERS_FILE path
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`✅ Users file updated with ${users.length} users`);
        
        res.json({ success: true, message: `Updated ${users.length} users` });
    } catch (error) {
        console.error('Error updating users:', error);
        res.status(500).json({ error: 'Failed to update users: ' + error.message });
    }
});

app.delete('/api/users/:username', (req, res) => {
    try {
        const { username } = req.params;
        let users = readData(USERS_FILE);
        const initialLength = users.length;
        users = users.filter(u => u.username !== username);
        
        if (users.length === initialLength) {
            return res.status(404).json({ error: 'User not found' });
        }

        const success = writeData(USERS_FILE, users);
        
        if (!success) {
            return res.status(500).json({ error: 'Failed to delete user' });
        }
        
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

app.put('/api/users/:username/role', (req, res) => {
    const { username } = req.params;
    const { role } = req.body;
    if (role !== 'manager' && role !== 'sales') {
        return res.status(400).json({ error: 'Invalid role. Only "manager" or "sales" allowed.' });
    }
    let users = readData(USERS_FILE);
    const userIndex = users.findIndex(u => u.username === username);

    if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
    }

    const currentUser = users[userIndex];
    if (username === 'admin') {
        return res.status(403).json({ error: 'Cannot modify main admin' });
    }
    if (role === 'manager' && currentUser.role !== 'sales') {
        return res.status(403).json({ error: 'Only sales associates can be promoted to manager' });
    }
    if (role === 'sales' && currentUser.role !== 'manager') {
        return res.status(403).json({ error: 'Only managers can be demoted to sales' });
    }

    // Set role and record promotion/demotion timestamp
    users[userIndex].role = role;
    if (role === 'manager') {
        users[userIndex].promotionDate = new Date().toISOString(); // canonical ISO timestamp
        // optional: store human-friendly date too
        users[userIndex].promotionDateLabel = new Date().toLocaleString();
    } else {
        // demoted to sales -> remove promotion data
        delete users[userIndex].promotionDate;
        delete users[userIndex].promotionDateLabel;
    }

    if (!writeData(USERS_FILE, users)) {
        return res.status(500).json({ error: 'Failed to update user role' });
    }

    // Broadcast manager promotion/demotion with date
    if (role === 'manager') {
        broadcast({
            type: 'system-announcement',
            event: 'manager-promoted',
            username,
            message: `${username} has been promoted to Manager!`,
            date: users[userIndex].promotionDateLabel || new Date().toLocaleString()
        });
    } else if (role === 'sales') {
        broadcast({
            type: 'system-announcement',
            event: 'manager-demoted',
            username,
            message: `${username} has been demoted to Sales Associate.`,
            date: new Date().toLocaleString()
        });
    }

    res.json(users[userIndex]);
});
const EXPENSE_FILE = path.join(userDataPath, 'expense.json');
if (!fs.existsSync(EXPENSE_FILE)) fs.writeFileSync(EXPENSE_FILE, JSON.stringify([]));

// Get all expenses
app.get('/api/expenses', (req, res) => {
    try {
        const expenses = JSON.parse(fs.readFileSync(EXPENSE_FILE, 'utf8'));
        res.json(expenses);
    } catch (e) {
        res.status(500).json([]);
    }
});

// Add a new expense
app.post('/api/expenses', (req, res) => {
    try {
        const expense = req.body;
        let expenses = JSON.parse(fs.readFileSync(EXPENSE_FILE, 'utf8'));
        expenses.push(expense);
        fs.writeFileSync(EXPENSE_FILE, JSON.stringify(expenses, null, 2));
        res.status(201).json(expense);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save expense' });
    }
});

// API endpoint to get all sales
app.get('/api/sales', (req, res) => {
    try {
        const { start, end } = req.query; 
        const sales = readData(SALES_FILE); 
        if (!start || !end) {
            const today = new Date().toISOString().slice(0, 10);
            const todaySales = sales.filter(sale => sale.dateSold === today);
            return res.json(todaySales);
        }
        const filteredSales = sales.filter(sale => {
            if (!sale.dateSold) return false; 
            return sale.dateSold >= start && sale.dateSold <= end;
        });

        res.json(filteredSales);
        
    } catch (error) {
        console.error('Error fetching sales:', error);
        res.status(500).json({ error: 'Failed to fetch sales' });
    }
});
app.post('/api/sales/update-missing-dates', (req, res) => {
    try {
        const sales = readData(SALES_FILE);
        let updatedCount = 0;

        sales.forEach(sale => {
            if (!sale.dateSold || sale.dateSold.trim() === "") {
                if (sale.timestamp) {
                    // Example timestamp: "08/11/2025 09:56:23"
                    const datePart = sale.timestamp.split(" ")[0]; // "08/11/2025"
                    const parts = datePart.split("/");
                    if (parts.length === 3) {
                        const [day, month, year] = parts;
                        sale.dateSold = `${year}-${month}-${day}`; // → "2025-11-08"
                        updatedCount++;
                    }
                } else {
                    // fallback if no timestamp
                    sale.dateSold = new Date().toISOString().slice(0, 10);
                    updatedCount++;
                }
            }
        });

        if (updatedCount > 0) {
            writeData(SALES_FILE, sales);
            console.log(`✅ Fixed ${updatedCount} sale records missing dateSold.`);
        }

        res.json({
            success: true,
            updatedCount,
            message: `Fixed ${updatedCount} sale records missing dateSold.`
        });
    } catch (error) {
        console.error('Error fixing missing sale dates:', error);
        res.status(500).json({ success: false, error: 'Failed to update missing sale dates.' });
    }
});

app.post('/api/newsales', async (req, res) => {
    try {
        console.log('══════════════════════════════════════════════════════════════════');
        console.log('🛒 NEW SALE REQUEST RECEIVED');
        console.log('══════════════════════════════════════════════════════════════════');
        
        const sale = req.body;
        console.log('📦 SALE DATA RECEIVED:');
        console.log(JSON.stringify(sale, null, 2));
        console.log('──────────────────────────────────────────────────────────────────');
        
        // Check if this is a credit payment
        const isCreditPayment = sale.type === 'credit-payment' || 
                               (sale.paymentType && sale.paymentType.includes('Credit Payment'));
        
        if (isCreditPayment) {
            console.log('💳 CREDIT PAYMENT - Processing without stock check');
            
            // Just save the sale without stock update
            const sales = readData(SALES_FILE);
            sales.push(sale);
            const saleSaveSuccess = writeData(SALES_FILE, sales);
            
            if (!saleSaveSuccess) {
                return res.status(500).json({ error: 'Failed to save credit payment' });
            }
            
            // Create notification
            const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
            const users = readData(USERS_FILE);
            const user = users.find(u => u.username === sale.username);
            
            const paymentNotification = {
                id: Date.now(),
                type: 'credit-payment',
                message: `Credit payment received: ${sale.productName} - ${sale.totalAmount || sale.amount || 0} FCFA`,
                date: new Date().toLocaleString(),
                user: sale.username || 'Unknown',
                userImage: user && user.photo ? user.photo : null,
                productName: sale.productName,
                amount: sale.totalAmount || sale.amount || 0,
                customerName: sale.customerName
            };
            
            ntfs.unshift(paymentNotification);
            fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
            
            // Broadcast
            if (typeof broadcast === 'function') {
                broadcast({ type: 'new-sale', sale: sale });
                broadcast({ 
                    type: 'new-notification', 
                    notification: paymentNotification 
                });
            }
            
            console.log('✅ Credit payment recorded in sales history');
            
            return res.status(201).json({ 
                message: 'Credit payment recorded successfully',
                sale,
                isCreditPayment: true
            });
        }
        
        // Regular product sale processing
        console.log('📊 Processing regular product sale...');
        
        const sales = readData(SALES_FILE);
        const stock = readData(STOCK_FILE);
        
        console.log(`📊 STOCK DATABASE: ${stock.length} items total`);
        console.log('──────────────────────────────────────────────────────────────────');
        
        let soldItem = null;
        let currentQuantity = 0;
        
        console.log(`🔍 SEARCHING FOR ITEM:`);
        console.log(`   Looking for ID: "${sale.itemId}"`);
        console.log(`   Product Name: "${sale.productName}"`);
        
        // Find item by ID
        if (sale.itemId) {
            soldItem = stock.find(item => String(item.id).trim() === String(sale.itemId).trim());
            if (soldItem) {
                console.log(`✅ FOUND: ID match "${soldItem.name}"`);
            }
        }
        
        // If not found by ID, try name
        if (!soldItem) {
            soldItem = stock.find(item => 
                item.name.toLowerCase().trim() === sale.productName.toLowerCase().trim()
            );
            if (soldItem) {
                console.log(`✅ FOUND: Name match "${soldItem.name}"`);
            }
        }
        
        if (!soldItem) {
            console.log(`❌❌❌ ITEM NOT FOUND IN STOCK!`);
            return res.status(404).json({ 
                error: 'Item not found in stock',
                productName: sale.productName,
                itemId: sale.itemId
            });
        }
        
        // GET CURRENT QUANTITY
        currentQuantity = soldItem.quantity;
        
        console.log('──────────────────────────────────────────────────────────────────');
        console.log(`📦 ITEM FOUND:`);
        console.log(`   Name: ${soldItem.name}`);
        console.log(`   ID: ${soldItem.id}`);
        console.log(`   Current Quantity: ${currentQuantity} units`);
        console.log(`   Sale Quantity: ${sale.quantity} units`);
        console.log(`📊 BEFORE Sale: ${currentQuantity} units available`);
        
        // SAVE THE SALE
        console.log('──────────────────────────────────────────────────────────────────');
        console.log(`💾 SAVING SALE RECORD...`);
        sales.push(sale);
        const saleSaveSuccess = writeData(SALES_FILE, sales);
        
        if (!saleSaveSuccess) {
            console.log(`❌ FAILED to save sale`);
            return res.status(500).json({ error: 'Failed to save sale' });
        }
        console.log(`✅ Sale saved to database`);
        
        // BROADCAST SALE
        if (typeof broadcast === 'function') {
            broadcast({ type: 'new-sale', sale: sale });
            console.log(`📡 Sale broadcasted to all users`);
        }
        
        // NOTIFICATIONS
        console.log('──────────────────────────────────────────────────────────────────');
        console.log(`🔔 PROCESSING NOTIFICATIONS...`);
        
        const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
        const users = readData(USERS_FILE);
        const user = users.find(u => u.username === sale.username);
        
        // Sale Notification
        const saleNotification = {
            id: Date.now(),
            type: 'sale',
            message: `New sale: ${sale.productName} x${sale.quantity} for ${sale.price} FCFA`,
            date: new Date().toLocaleString(),           
            user: sale.username || 'Unknown',
            userImage: user && user.photo ? user.photo : null,
            productName: sale.productName,
            productImage: soldItem ? soldItem.image : null,
            itemData: soldItem || null,
            saleData: sale,
            currentQuantityBeforeSale: currentQuantity
        };
        
        ntfs.unshift(saleNotification);
        console.log(`✅ Sale notification created`);
        
        let lowStockNotification = null;
        let emailStatus = 'not_needed';
        
        // ✅ STOCK UPDATE AND LOW STOCK CHECK
        if (sale.type === 'product' && soldItem) {
            console.log('──────────────────────────────────────────────────────────────────');
            console.log(`📦 UPDATING STOCK QUANTITY...`);
            
            // Calculate new quantity
            const newQuantity = currentQuantity - sale.quantity;
            console.log(`   Calculation: ${currentQuantity} - ${sale.quantity} = ${newQuantity}`);
            
            // Update stock
            soldItem.quantity = newQuantity;
            soldItem.hasBeenSold = true;
            
            // Save updated stock
            const stockIndex = stock.findIndex(item => item.id === soldItem.id);
            if (stockIndex !== -1) {
                stock[stockIndex] = soldItem;
                const stockSaveSuccess = writeData(STOCK_FILE, stock);
                if (!stockSaveSuccess) {
                    console.log(`❌ FAILED to save stock update`);
                } else {
                    console.log(`✅ Stock updated in database`);
                }
            }
            
            console.log(`📊 AFTER Sale: ${newQuantity} units remaining`);
            
            // ✅ LOW STOCK CHECK - ALWAYS CHECK!
            console.log('──────────────────────────────────────────────────────────────────');
            console.log(`📉 CHECKING FOR LOW STOCK...`);
            console.log(`   Current quantity: ${newQuantity} units`);
            
            if (newQuantity <= 3 && soldItem.hasBeenSold) {
                console.log(`   ⚠️ LOW STOCK DETECTED: ${newQuantity} units remaining`);
                console.log(`   ⚠️ LOW STOCK DETECTED: ${newQuantity} units remaining`);
                
                // ✅ ALWAYS CREATE LOW STOCK NOTIFICATION (Users always see this!)
                const lowStockMessage = newQuantity === 0 
                    ? `${soldItem.name} is out of stock! (Was ${currentQuantity}, now 0)`
                    : `Low stock alert: ${soldItem.name} (Was ${currentQuantity}, now ${newQuantity} left)`;
                
                lowStockNotification = {
                    id: Date.now() + 1,
                    type: 'low-stock',
                    message: lowStockMessage,
                    productName: soldItem.name,
                    stockQuantity: newQuantity,
                    previousQuantity: currentQuantity,
                    productImage: soldItem.image || 'image/out of stock.png',
                    date: new Date().toLocaleString(), 
                    itemId: soldItem.id,                      
                    itemData: soldItem
                };
                
                // ✅ ALWAYS ADD TO NOTIFICATIONS
                ntfs.unshift(lowStockNotification);
                console.log(`   ✅ Low stock notification created: "${lowStockMessage}"`);
                
                // ✅ ALWAYS BROADCAST TO ALL USERS (No duplicate check!)
                console.log(`   📡 BROADCASTING TO ALL USERS...`);
                if (typeof broadcast === 'function') {
                    broadcast({
                        type: 'low-stock',
                        notification: lowStockNotification
                    });
                    console.log(`   ✅ Broadcasted to all connected users`);
                }
                
                // ✅ CHECK FOR EMAIL DUPLICATES (Separate from app notifications)
                const oneHourAgo = Date.now() - 3600000; // 1 hour in milliseconds
                const existingEmail = ntfs.find(
                    n => n.type === 'low-stock-email-sent' &&
                    n.productName === soldItem.name &&
                    new Date(n.date).getTime() > oneHourAgo
                );
                
            console.log(`📧 SENDING EMAIL ALERT...`);
            try {
                await sendLowStockAlert([soldItem]);
                console.log(`   ✅ Email sent successfully`);
                emailStatus = 'email_sent_successfully';
            } catch (err) {
                console.error(`   ❌ EMAIL FAILED:`, err.message);
                emailStatus = 'email_failed';
            }
                
            } else {
                console.log(`   ✅ Stock normal: ${newQuantity} units`);
                emailStatus = 'not_needed';
            }
        } else {
            console.log(`   ℹ️ Not a product sale (type: ${sale.type})`);
            emailStatus = 'not_product';
        }
        
        // SAVE ALL NOTIFICATIONS
        console.log('──────────────────────────────────────────────────────────────────');
        console.log(`💾 SAVING ALL NOTIFICATIONS...`);
        fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
        console.log(`✅ Notifications saved`);
        
        // ✅ BROADCAST SALE NOTIFICATION TO ALL USERS
        console.log(`📡 BROADCASTING SALE NOTIFICATION...`);
        if (typeof broadcast === 'function') {
            broadcast({ 
                type: 'new-notification', 
                notification: saleNotification 
            });
            console.log(`   ✅ Sale notification broadcasted`);
        }
        
        console.log('══════════════════════════════════════════════════════════════════');
        console.log(`✅ SALE PROCESSING COMPLETE`);
        console.log(`   Product: ${sale.productName}`);
        console.log(`   Quantity Sold: ${sale.quantity}`);
        console.log(`   New Stock: ${soldItem.quantity} units`);
        console.log(`   Low Stock Notification: ${lowStockNotification ? 'SHOWN TO ALL USERS' : 'Not needed'}`);
        console.log(`   Email Status: ${emailStatus}`);
        console.log('══════════════════════════════════════════════════════════════════\n');
        
        res.status(201).json({ 
            message: 'Sale added successfully', 
            sale,
            lowStockNotification: lowStockNotification ? true : false,
            usersSeeNotification: true, // Users always see it
            emailStatus: emailStatus,
            currentQuantityBefore: currentQuantity,
            newQuantityAfter: soldItem ? soldItem.quantity : null
        });
        
    } catch (error) {
        console.error('══════════════════════════════════════════════════════════════════');
        console.error('❌❌❌ ERROR IN /api/newsales ❌❌❌');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('══════════════════════════════════════════════════════════════════\n');
        
        res.status(500).json({ 
            error: 'Failed to add sale',
            details: error.message
        });
    }
});

app.post('/api/credit-payments', async (req, res) => {
    try {
        console.log('💳 CREDIT PAYMENT REQUEST RECEIVED');
        console.log('Data:', req.body);
        
        const payment = req.body;
        
        // 1. Save to sales database
        const sales = readData(SALES_FILE);
        sales.push(payment);
        const saleSaveSuccess = writeData(SALES_FILE, sales);
        
        if (!saleSaveSuccess) {
            return res.status(500).json({ error: 'Failed to save credit payment' });
        }
        
        // 2. Broadcast if needed
        if (typeof broadcast === 'function') {
            broadcast({ type: 'new-credit-payment', payment: payment });
        }
        
        // 3. Create a notification for credit payment
        const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
        const users = readData(USERS_FILE);
        const user = users.find(u => u.username === payment.username);
        
        // Simple message without currency formatting
        const paymentNotification = {
            id: Date.now(),
            type: 'credit-payment',
            message: `Credit payment received: ${payment.productName} - ${payment.totalAmount || payment.amount || 0} FCFA`,
            date: new Date().toLocaleString(),
            user: payment.username || 'Unknown',
            userImage: user && user.photo ? user.photo : null,
            productName: payment.productName,
            amount: payment.totalAmount || payment.amount || 0,
            customerName: payment.customerName
        };
        
        ntfs.unshift(paymentNotification);
        fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
        
        // 4. Broadcast notification
        if (typeof broadcast === 'function') {
            broadcast({ 
                type: 'new-notification', 
                notification: paymentNotification 
            });
        }
        
        console.log('✅ Credit payment recorded successfully');
        
        res.status(201).json({ 
            message: 'Credit payment recorded successfully',
            payment,
            notificationCreated: true
        });
        
    } catch (error) {
        console.error('❌ Error in /api/credit-payments:', error);
        res.status(500).json({ 
            error: 'Failed to record credit payment',
            details: error.message
        });
    }
});
// NEW: API endpoint to get all stock items
app.get('/api/stock', (req, res) => {
    try {
        const stock = readData(STOCK_FILE);
        res.json(stock);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stock' });
    }
});

// NEW: API endpoint to add or update a stock item
app.post('/api/stock', (req, res) => {
    try {
        const newItem = req.body;
        let stock = readData(STOCK_FILE);

        // ✅ Always ensure the item has a unique ID
        if (!newItem.id) {
            newItem.id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        }

        // --- Find the item by ID first (most reliable) ---
        let existingIndex = stock.findIndex(item => item.id === newItem.id);

        // --- If not found by ID, try by name (for backward compatibility) ---
        if (existingIndex === -1) {
            if (newItem.oldName && newItem.oldName.toLowerCase() !== newItem.name.toLowerCase()) {
                existingIndex = stock.findIndex(item => item.name.toLowerCase() === newItem.oldName.toLowerCase());
            } else {
                existingIndex = stock.findIndex(item => item.name.toLowerCase() === newItem.name.toLowerCase());
            }
        }

        let oldName = newItem.oldName || null;

        if (existingIndex > -1) {
            // ✅ Update existing item (preserve id)
            const oldItem = stock[existingIndex];
            stock[existingIndex] = { ...oldItem, ...newItem, id: oldItem.id }; // keep the same id
            stock[existingIndex].quantity = parseInt(stock[existingIndex].quantity, 10);

            // --- Update sales and credit sales if name changed ---
            if (oldName && oldName.toLowerCase() !== newItem.name.toLowerCase()) {
                let sales = readData(SALES_FILE);
                let updatedSales = false;
                sales.forEach(sale => {
                    if (sale.productName && sale.productName.toLowerCase() === oldName.toLowerCase()) {
                        sale.productName = newItem.name;
                        updatedSales = true;
                    }
                });
                if (updatedSales) writeData(SALES_FILE, sales);

                let creditSales = readData(CREDIT_SALES_FILE);
                let updatedCredits = false;
                creditSales.forEach(cs => {
                    if (cs.productName && cs.productName.toLowerCase() === oldName.toLowerCase()) {
                        cs.productName = newItem.name;
                        updatedCredits = true;
                    }
                });
                if (updatedCredits) writeData(CREDIT_SALES_FILE, creditSales);
            }

        } else {
            // ✅ Add new item (auto-ID guaranteed)
            stock.push(newItem);
        }

        const success = writeData(STOCK_FILE, stock);

        if (!success) {
            return res.status(500).json({ error: 'Failed to save stock item' });
        }

        // --- Low stock check ---
           const LOW_STOCK_THRESHOLD = 3;
        const lowStockItems = stock.filter(item => item.quantity <= LOW_STOCK_THRESHOLD);

        if (lowStockItems.length > 0) {
            const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
            
            lowStockItems.forEach(item => {
                // Check if similar notification exists (same product, within last hour)
                const existingLowStockNotif = ntfs.find(
                    n => n.type === 'low-stock' &&
                    n.productName === item.name &&
                    (Date.now() - new Date(n.date).getTime() < 3600000)
                );

                if (!existingLowStockNotif) {
                    const lowStockMessage = item.quantity === 0 
                        ? `${item.name} is out of stock!`
                        : `Low stock alert: ${item.name} (${item.quantity} left)`;
                    
                    ntfs.unshift({
                        id: Date.now(),
                        type: 'low-stock',
                        message: lowStockMessage,
                        productName: item.name,
                        stockQuantity: item.quantity,
                        productImage: item.image || 'image/out of stock.png',
                        date: new Date().toLocaleString(),                        
                        itemData: item 
                    });
                }
            });
            
            fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
        }

        res.status(200).json({ message: 'Stock item saved successfully', item: newItem });
    } catch (error) {
        console.error("Error in /api/stock:", error);
        res.status(500).json({ error: 'Failed to process stock item' });
    }
});

// NEW: API endpoint to delete a stock item
app.delete('/api/stock/:itemName', (req, res) => {
    try {
        const { itemName } = req.params;
        let stock = readData(STOCK_FILE);
        
        // 1. Find the item *before* filtering the array
        const itemToDelete = stock.find(item => item.name.toLowerCase() === itemName.toLowerCase());

        if (!itemToDelete) {
            // Item not found, send 404
            return res.status(404).json({ error: 'Stock item not found' });
        }

        // 2. Filter the item out of the array
        stock = stock.filter(item => item.name.toLowerCase() !== itemName.toLowerCase());
        
        // 3. Write the updated array back to the file
        const success = writeData(STOCK_FILE, stock);

        if (!success) {
            // If writing the file fails, stop here
            return res.status(500).json({ error: 'Failed to update stock.json' });
        }

        // 4. If write was successful AND the item had an image, delete the image file
        if (itemToDelete.imageUrl) {
            try {
                // Extract filename from URL (e.g., "/uploads/image.png" -> "image.png")
                const imageName = path.basename(itemToDelete.imageUrl);
                
                // Build the full path to the image in the /MEMORY/uploads/ folder
                const imagePath = path.join(uploadDir, imageName);

                // Use fs.unlink to delete the file
                fs.unlink(imagePath, (err) => {
                    if (err) {
                        // Log the error, but don't stop the response.
                        // The item was still deleted from the JSON.
                        console.warn(`Failed to delete image file: ${imagePath}`, err.message);
                    } else {
                        console.log(`Successfully deleted image: ${imagePath}`);
                    }
                });
            } catch (fileError) {
                // Catch any errors from path.basename or path.join
                console.warn(`Error processing image path for deletion: ${itemToDelete.imageUrl}`, fileError);
            }
        }

        // 5. Send success response
        res.json({ message: 'Stock item deleted successfully' });

    } catch (error) {
        console.error('Error in DELETE /api/stock/:itemName:', error);
        res.status(500).json({ error: 'Failed to delete stock item' });
    }
});;

// NEW: API endpoint to get all stock history entries
app.post('/api/stock-history', (req, res) => {
    try {
        const newEntry = req.body;
        
        // Normalize the entry before saving
        const normalizedEntry = normalizeStockHistoryEntry(newEntry);
        
        const stockHistory = readData(STOCK_HISTORY_FILE);
        stockHistory.push(normalizedEntry);
        const success = writeData(STOCK_HISTORY_FILE, stockHistory);

        if (!success) {
            return res.status(500).json({ error: 'Failed to save stock history entry' });
        }

        res.status(201).json({ 
            message: 'Stock history entry added successfully', 
            entry: normalizedEntry 
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add stock history entry' });
    }
});
app.get('/api/stock-history', (req, res) => {
    try {
        const { start, end } = req.query; // Optional date range
        const stockHistory = readData(STOCK_HISTORY_FILE); // Read all history
        
        // Function to get date from entry (handles multiple formats)
        const getEntryDate = (entry) => {
            if (entry.date) {
                return entry.date; // Already in YYYY-MM-DD format
            }
            if (entry.timestamp) {
                try {
                    const date = new Date(entry.timestamp);
                    return date.toISOString().slice(0, 10); // Convert to YYYY-MM-DD
                } catch (e) {
                    return null;
                }
            }
            return null;
        };

        let filteredHistory;
        
        // If date range provided, filter by it
        if (start && end) {
            filteredHistory = stockHistory.filter(entry => {
                const entryDate = getEntryDate(entry);
                if (!entryDate) return false;
                return entryDate >= start && entryDate <= end;
            });
        } else {
            // If no date range, return all history (not just today)
            filteredHistory = stockHistory;
        }

        res.json(filteredHistory); // Send filtered result

    } catch (error) {
        console.error('Error fetching stock history:', error);
        res.status(500).json({ error: 'Failed to fetch stock history' });
    }
});
// Add this enhanced stock history endpoint that automatically fixes IDs when loading
app.get('/api/stock-history/fixed', (req, res) => {
    try {
        const { start, end } = req.query;
        
        // First, run the fix function to ensure data is consistent
        updateStockHistoryWithItemIds();
        
        // Then load the stock history as normal
        const stockHistory = readData(STOCK_HISTORY_FILE);
        
        if (!start || !end) {
            const today = new Date().toISOString().slice(0, 10);
            const todayStock = stockHistory.filter(entry => {
                try {
                    const entryDate = new Date(entry.timestamp || entry.date || Date.now());
                    return entryDate.toISOString().slice(0, 10) === today;
                } catch {
                    return false;
                }
            });
            return res.json(todayStock);
        }
        
        // Filter by date range
        const filteredStock = stockHistory.filter(entry => {
            try {
                if (!entry.timestamp && !entry.date) return false;
                const entryDate = new Date(entry.timestamp || entry.date);
                const startDate = new Date(start);
                const endDate = new Date(end);
                endDate.setHours(23, 59, 59, 999);
                return entryDate >= startDate && entryDate <= endDate;
            } catch {
                return false;
            }
        });
        
        // Enhance entries with current stock data
        const stock = readData(STOCK_FILE);
        const enhancedHistory = filteredStock.map(entry => {
            let stockItem = null;
            
            // Try to find matching stock item
            if (entry.itemId) {
                stockItem = stock.find(item => item.id === entry.itemId);
            }
            
            if (!stockItem && entry.itemName) {
                stockItem = stock.find(item => 
                    item.name.toLowerCase() === entry.itemName.toLowerCase()
                );
            }
            
            return {
                ...entry,
                itemId: stockItem ? stockItem.id : entry.itemId,
                itemName: stockItem ? stockItem.name : entry.itemName,
                hasMatchingStockItem: !!stockItem,
                currentQuantity: stockItem ? stockItem.quantity : 'N/A'
            };
        });
        
        res.json(enhancedHistory);
        
    } catch (error) {
        console.error('Error fetching fixed stock history:', error);
        res.status(500).json({ error: 'Failed to fetch stock history' });
    }
});

// Add this function to normalize stock history when entries are added
function normalizeStockHistoryEntry(entry) {
    const stock = readData(STOCK_FILE);
    
    // If entry has itemId, ensure it matches a stock item
    if (entry.itemId) {
        const stockItem = stock.find(item => item.id === entry.itemId);
        if (stockItem) {
            entry.itemName = stockItem.name;
        }
    }
    // If entry has itemName but no itemId, try to find matching stock item
    else if (entry.itemName) {
        const stockItem = stock.find(item => 
            item.name.toLowerCase() === entry.itemName.toLowerCase()
        );
        if (stockItem) {
            entry.itemId = stockItem.id;
            entry.itemName = stockItem.name; // Use exact name from stock
        }
    }
    
    // Ensure timestamp is properly formatted
    if (entry.timestamp) {
        try {
            // Convert to standard format if needed
            if (typeof entry.timestamp === 'string' && entry.timestamp.includes('/')) {
                // Format: "DD/MM/YYYY HH:MM:SS"
                const [datePart, timePart] = entry.timestamp.split(' ');
                const [day, month, year] = datePart.split('/').map(Number);
                const [hour, minute, second] = timePart ? timePart.split(':').map(Number) : [0, 0, 0];
                entry.timestamp = new Date(year, month - 1, day, hour, minute, second).toISOString();
            }
        } catch (error) {
            console.warn('Could not normalize timestamp:', entry.timestamp);
        }
    }
    
    return entry;
}
// NEW: API endpoint to add a new stock history entry
app.post('/api/stock-history', (req, res) => {
    try {
        const newEntry = req.body;
        const stockHistory = readData(STOCK_HISTORY_FILE);
        stockHistory.push(newEntry);
        const success = writeData(STOCK_HISTORY_FILE, stockHistory);

        if (!success) {
            return res.status(500).json({ error: 'Failed to save stock history entry' });
        }

        res.status(201).json({ message: 'Stock history entry added successfully', entry: newEntry });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add stock history entry' });
    }
});

// NEW: API endpoint to get business information
app.get('/api/business-info', (req, res) => {
    try {
        const businessInfo = readData(BUSINESS_INFO_FILE);
        // If businessInfo.json is empty or corrupted, readData might return [], so ensure it's an object.
        if (Array.isArray(businessInfo)) {
             return res.json({
                name: '',
                shopNumber: '',
                phoneNumberTwo: '',
                address: '',
                emailOrWebsite: '',
                logoData: '',
                socialMediaHandles: '',
                details: ''
            });
        }
        res.json(businessInfo);
    } catch (error) {
        console.error('Error fetching business info:', error);
        res.status(500).json({ error: 'Failed to fetch business information' });
    }
});

// NEW: API endpoint to update business information
app.post('/api/business-info', (req, res) => {
    try {
        const updatedBusinessInfo = req.body;
        const success = writeData(BUSINESS_INFO_FILE, updatedBusinessInfo);

        if (!success) {
            return res.status(500).json({ error: 'Failed to save business information' });
        }

        res.status(200).json({ message: 'Business information updated successfully', businessInfo: updatedBusinessInfo });
    } catch (error) {
        console.error('Error updating business info:', error);
        res.status(500).json({ error: 'Failed to update business information' });
    }
});

// Get all notifications
app.get('/api/notifications', (req, res) => {
    try {
        const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
        res.json(ntfs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load notifications' });
    }
});

// Add a notification
app.post('/api/notifications', (req, res) => {
    try {
        const ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
        const notif = req.body;
        notif.id = Date.now();
        ntfs.unshift(notif); // newest first
        fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
        res.status(201).json(notif);
    } catch (err) {
        res.status(500).json({ error: 'Failed to save notification' });
    }
});

// Delete a notification
app.delete('/api/notifications/:id', (req, res) => {
    try {
        let ntfs = JSON.parse(fs.readFileSync(NTF_FILE, 'utf8'));
        ntfs = ntfs.filter(n => n.id != req.params.id);
        fs.writeFileSync(NTF_FILE, JSON.stringify(ntfs, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});
app.delete('/api/notifications', (req, res) => {
    try {
        fs.writeFileSync(NTF_FILE, JSON.stringify([], null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear notifications' });
    }
});
// NEW: API to get all credit sales
app.get('/api/credit-sales', (req, res) => {
    fs.readFile(CREDIT_SALES_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading credit sales file:', err);
            return res.status(500).json({ message: 'Failed to load credit sales.' });
        }
        res.json(JSON.parse(data));
    });
});

// NEW: API to record a new credit sale
app.post('/api/credit-sales', (req, res) => {
    const newCreditSale = req.body;
    fs.readFile(CREDIT_SALES_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading credit sales file:', err);
            return res.status(500).json({ message: 'Failed to record credit sale.' });
        }
        const creditSales = JSON.parse(data);
        creditSales.push(newCreditSale);
        fs.writeFile(CREDIT_SALES_FILE, JSON.stringify(creditSales, null, 2), (err) => {
            if (err) {
                console.error('Error writing credit sales file:', err);
                return res.status(500).json({ message: 'Failed to record credit sale.' });
            }
            res.status(201).json(newCreditSale);
            broadcast({ type: 'new-credit-sale', creditSale: newCreditSale }); // Optional: broadcast new credit sale
        });
    });
});

// *FIXED*: This is the updated PUT route for credit sales
app.put('/api/credit-sales/:id', (req, res) => {
    const { id } = req.params;
    const updateFields = req.body; // Expects an object with fields to update (e.g., { status: 'paid', creditBalance: 0 })

    fs.readFile(CREDIT_SALES_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading credit sales file:', err);
            return res.status(500).json({ message: 'Failed to update credit sale.' });
        }
        let creditSales = JSON.parse(data);
        const saleIndex = creditSales.findIndex(sale => String(sale.id) === String(id)); // Use sale.id consistent with script.js
        if (saleIndex === -1) {
            return res.status(404).json({ message: 'Credit sale not found.' });
        }

        // Apply updates to the found credit sale
        creditSales[saleIndex] = { ...creditSales[saleIndex], ...updateFields };

        fs.writeFile(CREDIT_SALES_FILE, JSON.stringify(creditSales, null, 2), (err) => {
            if (err) {
                console.error('Error writing credit sales file:', err);
                return res.status(500).json({ message: 'Failed to update credit sale' });
            }
            res.json(creditSales[saleIndex]);
            // Optional: broadcast update if needed
        });
    });
});
const REMINDERS_FILE = path.join(userDataPath, 'reminders.json');
if (!fs.existsSync(REMINDERS_FILE)) fs.writeFileSync(REMINDERS_FILE, JSON.stringify([]));

// Get reminders
app.get('/api/reminders', (req, res) => {
    try {
        const reminders = readData(REMINDERS_FILE);
        res.json(reminders);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reminders' });
    }
});

// Add or update reminder
app.post('/api/reminders', (req, res) => {
    try {
        let reminders = readData(REMINDERS_FILE);
        const reminder = req.body;
        if (!reminder.id) reminder.id = Date.now();
        const idx = reminders.findIndex(r => r.id === reminder.id);
        if (idx > -1) reminders[idx] = reminder;
        else reminders.push(reminder);
        writeData(REMINDERS_FILE, reminders);
        res.json(reminder);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save reminder' });
    }
});
// Delete ONE reminder by ID
app.delete('/api/reminders/:id', (req, res) => {
    try {
        let reminders = readData(REMINDERS_FILE);
        const { id } = req.params;
        reminders = reminders.filter(r => r.id != id); // Use != to safely compare numbers and strings
        writeData(REMINDERS_FILE, reminders);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete reminder' });
    }
});

// Delete ALL reminders (for reset)
app.delete('/api/reminders', (req, res) => {
    try {
        writeData(REMINDERS_FILE, []);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete all reminders' });
    }
});
// Delete ALL notes
app.delete('/api/notes', (req, res) => {
    try {
        writeData(NOTES_FILE, []);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete all notes' });
    }
});

// Delete ALL loans
app.delete('/api/loans', (req, res) => {
    try {
        writeData(LOAN_FILE, []);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete all loans' });
    }
});

// Delete ALL tasks
app.delete('/api/tasks', (req, res) => {
    try {
        writeData(TASKS_FILE, []);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete all tasks' });
    }
});

// Delete ALL expenses
app.delete('/api/expenses', (req, res) => {
    try {
        writeData(EXPENSE_FILE, []);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete all expenses' });
    }
});

// --- MASTER RESET ENDPOINT ---
app.delete('/api/reset-all', (req, res) => {
    try {
        console.log('--- INITIATING FULL SYSTEM RESET ---');

        // 1. Delete the entire uploads folder
        console.log(`Deleting ${uploadDir}...`);
        fs.rmSync(uploadDir, { recursive: true, force: true });

        // 2. Re-create the empty uploads folder
        console.log(`Re-creating ${uploadDir}...`);
        ensureFolderExists(uploadDir); // Uses your existing function

        // 3. Clear all data files by writing default empty data
        console.log('Resetting all data files...');
        writeData(SALES_FILE, []);
        writeData(STOCK_FILE, []);
        writeData(STOCK_HISTORY_FILE, []);
        writeData(CREDIT_SALES_FILE, []);
        writeData(NTF_FILE, []);
        writeData(REMINDERS_FILE, []);
        writeData(NOTES_FILE, []);
        writeData(LOAN_FILE, []);
        writeData(TASKS_FILE, []);
        writeData(EXPENSE_FILE, []);
        writeData(TARGETS_FILE, { weekly: 0, monthly: 0 });
        
        // 4. Reset Business Info
        writeData(BUSINESS_INFO_FILE, {
            name: '', shopNumber: '', phoneNumberTwo: '',
            address: '', emailOrWebsite: '', logoData: '',
            socialMediaHandles: '', details: ''
        });

        // 5. Reset Users File (CRITICAL: Must be done last)
        // This re-creates the default admin user
        writeData(USERS_FILE, [
            { username: 'admin', password: 'admin123', role: 'administrator' }
        ]);

        console.log('--- SYSTEM RESET COMPLETE ---');
        res.json({ success: true, message: 'Full system reset complete.' });

    } catch (e) {
        console.error('Error during system reset:', e);
        res.status(500).json({ error: 'Failed to reset system: ' + e.message });
    }
});
const ipFilePath = path.join(userDataPath, 'serverIp.json');

function getLocalNetworkIP() {
  if (isOfflineMode) {
    console.log('🔌 Server running in offline mode');
    return '127.0.0.1';
  }
  
  const interfaces = os.networkInterfaces();
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
app.use('/css', express.static(path.join(baseDataPath, 'css')));
app.use('/libs', express.static(path.join(baseDataPath, 'libs')));
app.use('/styles', express.static(path.join(baseDataPath, 'styles')));
app.use('/dist', express.static(path.join(baseDataPath, 'dist')));
app.use('/image', express.static(path.join(baseDataPath, 'image')));
app.use('/audio', express.static(path.join(baseDataPath, 'audio')));
app.use(express.static(__dirname));
app.use(express.static(__dirname)); 
// Enable CORS



///////////////////////////id FIXING UTILITIES ///////////////////////////
function ensureStockHasIds() {
    let stock = readData(STOCK_FILE);
    let changed = false;

    stock = stock.map(item => {
        if (!item.id) {
            item.id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
            changed = true;
        }
        return item;
    });

    if (changed) {
        console.log("🆔 Assigned missing IDs to stock items");
        writeData(STOCK_FILE, stock);
    }
}
ensureStockHasIds();
// Helper to save IP info
function saveServerIp(ip, port) {
    fs.writeFileSync(ipFilePath, JSON.stringify({
        ip,
        port,
        timestamp: Date.now()
    }, null, 2));
}
function updateStockHistoryWithItemIds() {
    try {
        console.log("🔍 Scanning stock history to update item IDs...");
        
        const stock = readData(STOCK_FILE);
        const stockHistory = readData(STOCK_HISTORY_FILE);
        
        let updatedCount = 0;
        let matchedByNameCount = 0;
        
        // First pass: Update entries that already have IDs
        stockHistory.forEach(entry => {
            if (entry.itemId) {
                // Find matching item in stock by ID
                const matchedItem = stock.find(item => item.id === entry.itemId);
                if (matchedItem) {
                    // Ensure item name matches
                    if (entry.itemName && entry.itemName !== matchedItem.name) {
                        entry.itemName = matchedItem.name;
                        updatedCount++;
                    }
                }
            }
        });
        
        // Second pass: Match entries without IDs by name
        stockHistory.forEach(entry => {
            if (!entry.itemId && entry.itemName) {
                // Try to find matching item in stock by name (case-insensitive)
                const matchedItem = stock.find(item => 
                    item.name.toLowerCase() === entry.itemName.toLowerCase()
                );
                
                if (matchedItem) {
                    entry.itemId = matchedItem.id;
                    matchedByNameCount++;
                    updatedCount++;
                }
            }
        });
        
        // Write back updated stock history
        if (updatedCount > 0) {
            writeData(STOCK_HISTORY_FILE, stockHistory);
            console.log(`✅ Updated ${updatedCount} stock history entries:`);
            console.log(`   • ${matchedByNameCount} entries matched by name and assigned IDs`);
            console.log(`   • ${updatedCount - matchedByNameCount} entries corrected item names`);
        } else {
            console.log("ℹ️ No stock history entries needed updating");
        }
        
        return {
            success: true,
            updatedCount,
            matchedByNameCount,
            message: `Updated ${updatedCount} stock history entries`
        };
        
    } catch (error) {
        console.error('❌ Error updating stock history with item IDs:', error);
        return {
            success: false,
            error: error.message
        };
    }
}
function updateSalesWithStockIdsAndAggregate() {
    try {
        console.log("🔍 Scanning sales to assign stock item IDs and aggregate totals...");

        const sales = readData(SALES_FILE) || [];
        const stock = readData(STOCK_FILE) || [];

        // Build lookup: lowercased stock name -> stock item
        const stockByName = new Map();
        stock.forEach(item => {
            if (item && item.name) stockByName.set(String(item.name).trim().toLowerCase(), item);
        });

        let updatedCount = 0;
        const unmatchedNames = new Set();

        // Assign itemId on sales where possible
        sales.forEach(sale => {
            if (!sale) return;
            const prodName = (sale.productName || '').toString().trim();
            if (!prodName) return;
            const key = prodName.toLowerCase();

            if (!sale.itemId) {
                const matched = stockByName.get(key);
                if (matched && matched.id) {
                    sale.itemId = matched.id;
                    // Optionally keep canonical name from stock
                    sale.productName = matched.name;
                    updatedCount++;
                } else {
                    unmatchedNames.add(prodName);
                }
            }
        });

        // Write back updated sales if we added IDs
        if (updatedCount > 0) {
            writeData(SALES_FILE, sales);
            console.log(`✅ Assigned itemId to ${updatedCount} sales entries.`);
        } else {
            console.log("ℹ️ No sales needed itemId assignment.");
        }

        // Aggregate totals by itemId (or by productName if still unmatched)
        const aggregateMap = new Map();
        sales.forEach(sale => {
            if (!sale) return;
            const qty = Number(sale.quantity) || 0;
            const amt = Number(sale.totalAmount) || 0;
            const id = sale.itemId || null;
            const name = sale.productName || 'UNKNOWN';

            const key = id ? `id:${id}` : `name:${name.toString().trim().toLowerCase()}`;
            if (!aggregateMap.has(key)) {
                aggregateMap.set(key, {
                    itemId: id || null,
                    itemName: name,
                    totalQuantity: 0,
                    totalAmount: 0
                });
            }
            const entry = aggregateMap.get(key);
            entry.totalQuantity += qty;
            entry.totalAmount += amt;
        });

        const aggregated = Array.from(aggregateMap.values());

        return {
            success: true,
            updatedCount,
            unmatchedNames: Array.from(unmatchedNames).slice(0, 200),
            aggregated
        };
    } catch (error) {
        console.error('❌ Error in updateSalesWithStockIdsAndAggregate:', error);
        return { success: false, error: error.message };
    }
}

// API endpoint to trigger the repair + aggregation
app.get('/api/sales/repair-and-aggregate', (req, res) => {
    const result = updateSalesWithStockIdsAndAggregate();
    res.json(result);
});
function removeAllQRCodesFromStock() {
    try {
        console.log("🧹 Starting QR code cleanup...");
        
        // Read current stock data
        let stock = readData(STOCK_FILE);
        let cleanedCount = 0;
        let cleanedNames = [];
        
        // Process each stock item
        stock = stock.map(item => {
            const originalItem = { ...item };
            
            // Remove QR code fields
            if (item.grCode || item.qrCode || item.qrCodeData) {
                console.log(`❌ Removing QR code from: ${item.name}`);
                
                // Remove common QR code field names
                delete item.grCode;
                delete item.qrCode;
                delete item.qrCodeData;
                delete item.qrCodeBase64;
                delete item.qrcode;
                
                cleanedCount++;
                cleanedNames.push(item.name);
            }
            
            // Also remove imageData if it exists and is null
            if (item.imageData === null || item.imageData === 'null' || item.imageData === '') {
                delete item.imageData;
            }
            
            // Return cleaned item (only if it changed)
            if (JSON.stringify(originalItem) !== JSON.stringify(item)) {
                return item;
            }
            return originalItem;
        });
        
        // Save cleaned stock data
        const success = writeData(STOCK_FILE, stock);
        
        if (success) {
            console.log(`✅ Successfully cleaned ${cleanedCount} items of QR codes`);
            if (cleanedNames.length > 0) {
                console.log(`📋 Cleaned items: ${cleanedNames.join(', ')}`);
            }
            
            return {
                success: true,
                cleanedCount,
                cleanedNames,
                message: `Removed QR codes from ${cleanedCount} stock items`
            };
        } else {
            console.error("❌ Failed to save cleaned stock data");
            return {
                success: false,
                error: "Failed to save cleaned stock data"
            };
        }
        
    } catch (error) {
        console.error("❌ Error removing QR codes:", error);
        return {
            success: false,
            error: error.message
        };
    }
}


// Helper to load IP info
function loadServerIp() {
    if (fs.existsSync(ipFilePath)) {
        try {
            return JSON.parse(fs.readFileSync(ipFilePath, 'utf-8'));
        } catch (error) {
            console.error('Error parsing serverIp.json:', error);
            return null;
        }
    }
    return null;
}

function getCurrentNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (let name in interfaces) {
    for (let iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}


app.get('/api/local-ip', (req, res) => {
  let saved = loadServerIp();
  const currentIp = getCurrentNetworkIP();
  const currentPort = server.address() ? server.address().port : PORT;
  
  // If we have a saved IP and it's not APIPA/loopback and less than 1 year old
  const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  
  if (saved && saved.ip && saved.port && saved.timestamp && 
      (now - saved.timestamp < ONE_YEAR) &&
      !saved.ip.startsWith('169.254.') && saved.ip !== '127.0.0.1') {
    
    // Check if the saved IP is still valid (matches current network IP)
    if (saved.ip === currentIp) {
      res.json({
    ip: currentIp,
    port: currentPort,
    offline: isOfflineMode,
    hostname: 'StockApp.local'
  });
      return;
    } else {
      console.log(`Network IP changed from ${saved.ip} to ${currentIp}, updating...`);
    }
  }
  
  // Update with current IP
  saveServerIp(currentIp, currentPort);
  res.json({ ip: currentIp, port: currentPort });
});
app.get('/api/language-config', (req, res) => {
  try {
    const languageConfigPath = path.join(baseDataPath, 'MEMORY', 'language.json');
    if (fs.existsSync(languageConfigPath)) {
      const config = JSON.parse(fs.readFileSync(languageConfigPath, 'utf8'));
      res.json(config);
    } else {
      res.json({
        language: 'en',
        default: true
      });
    }
  } catch (error) {
    res.json({
      language: 'en',
      error: error.message
    });
  }
});
app.get('/locales/:lang.json', (req, res) => {
    const lang = req.params.lang;
    const localesDir = path.join(baseDataPath, 'locales');
    const langPath = path.join(localesDir, `${lang}.json`);
    const defaultPath = path.join(localesDir, 'en.json');
    
    if (fs.existsSync(langPath)) {
        res.sendFile(langPath);
    } else if (fs.existsSync(defaultPath)) {
        res.sendFile(defaultPath);
    } else {
        // Return basic English translations
        res.json({
            app: {
                title: "StockApp",
                loading: "Loading...",
                offline: "Offline Mode",
                online: "Online"
            }
        });
    }
});

// Get available languages
app.get('/api/available-languages', (req, res) => {
    const languages = [
        { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' },
        { code: 'es', name: 'Spanish', nativeName: 'Español', direction: 'ltr' },
        { code: 'fr', name: 'French', nativeName: 'Français', direction: 'ltr' },
        { code: 'de', name: 'German', nativeName: 'Deutsch', direction: 'ltr' },
        { code: 'zh', name: 'Chinese', nativeName: '中文', direction: 'ltr' },
        { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl' }
    ];
    res.json(languages);
});
// Serve language files dynamically
app.get('/locales/:lang.json', (req, res) => {
  const lang = req.params.lang;
  const langPath = path.join(baseDataPath, 'locales', `${lang}.json`);
  
  if (fs.existsSync(langPath)) {
    res.sendFile(langPath);
  } else {
    // Fallback to English
    res.sendFile(path.join(baseDataPath, 'locales', 'en.json'));
  }
})
// Health check API
app.get('/api/health', (req, res) => {
    // Disk space (cross-platform basic)
    function getDiskInfo(callback) {
        if (process.platform === 'win32') {
            exec('wmic logicaldisk get size,freespace,caption', (err, stdout) => {
                if (err) return callback({});
                const lines = stdout.trim().split('\n');
                let diskFree = 0, diskTotal = 0;
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length === 3 && parts[0].match(/^[A-Z]:$/)) {
                        diskFree += parseInt(parts[1] || 0, 10);
                        diskTotal += parseInt(parts[2] || 0, 10);
                    }
                });
                callback({
                    diskFree: (diskFree / (1024 ** 3)).toFixed(2) + ' GB',
                    diskTotal: (diskTotal / (1024 ** 3)).toFixed(2) + ' GB'
                });
            });
        } else {
            exec('df -k --output=avail,size /', (err, stdout) => {
                if (err) return callback({});
                const lines = stdout.trim().split('\n');
                if (lines.length >= 2) {
                    const [avail, size] = lines[1].trim().split(/\s+/);
                    callback({
                        diskFree: (parseInt(avail, 10) / (1024 ** 1)).toFixed(2) + ' MB',
                        diskTotal: (parseInt(size, 10) / (1024 ** 1)).toFixed(2) + ' MB'
                    });
                } else {
                    callback({});
                }
            });
        }
    }
        function getFolderSize(folderPath) {
        let total = 0;
        function walk(dir) {
            fs.readdirSync(dir).forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    walk(fullPath);
                } else {
                    total += stat.size;
                }
            });
        }
        walk(folderPath);
        return total;
    }

    // Simulate database check (since you use JSON files)
    let databaseStatus = 'ok';
    try {
        fs.accessSync(USERS_FILE, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
        databaseStatus = 'error';
    }

    // Memory info
    const memoryFree = (os.freemem() / (1024 ** 2)).toFixed(2) + ' MB';
    const memoryTotal = (os.totalmem() / (1024 ** 2)).toFixed(2) + ' MB';

    // App data usage
    let appDataUsage = 0;
    try {
        appDataUsage = getFolderSize(userDataPath);
    } catch (e) {
        appDataUsage = 0;
    }
    const appDataUsageMB = (appDataUsage / (1024 ** 2)).toFixed(2) + ' MB';

    getDiskInfo((disk) => {
        res.json({
            server: 'ok',
            database: databaseStatus,
            diskFree: disk.diskFree,
            diskTotal: disk.diskTotal,
            memoryFree,
            memoryTotal,
            uptime: (process.uptime() / 60).toFixed(1) + ' min',
            appDataUsage: appDataUsageMB
        });
    });
});
const NOTES_FILE = path.join(userDataPath, 'notes.json');
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, JSON.stringify([]));
// ...existing code...
// Get all notes
app.get('/api/notes', (req, res) => {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    res.json(notes);
  } catch (e) {
    res.status(500).json([]);
  }
});

// Save or update note
app.post('/api/notes', (req, res) => {
  try {
    let notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    const note = req.body;
    const idx = notes.findIndex(n => String(n.id) === String(note.id));
    if (idx > -1) notes[idx] = note;
    else notes.unshift(note);
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
    res.json(note);
  } catch (e) {
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// Delete note
app.delete('/api/notes/:id', (req, res) => {
  try {
    let notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    notes = notes.filter(n => String(n.id) !== String(req.params.id));
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

app.get('/api/loans', (req, res) => {
    try {
        const loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        res.json(loans);
    } catch (e) {
        res.status(500).json([]);
    }
});

// Add a new loan
app.post('/api/loans', (req, res) => {
    try {
        const loan = req.body;
        let loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        loan.id = loan.id || Date.now();
        loans.push(loan);
        fs.writeFileSync(LOAN_FILE, JSON.stringify(loans, null, 2));
        res.status(201).json(loan);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save loan' });
    }
});
app.post('/api/stock-history/fix-item-ids', (req, res) => {
    try {
        const result = updateStockHistoryWithItemIds();
        
        if (result.success) {
            res.json({
                success: true,
                updatedCount: result.updatedCount,
                matchedByNameCount: result.matchedByNameCount,
                message: result.message
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error in fix-item-ids endpoint:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fix stock history item IDs'
        });
    }
});

// Add this API endpoint to update a single stock history entry with item ID
app.post('/api/stock-history/update-entry/:entryId', (req, res) => {
    try {
        const { entryId } = req.params;
        const { itemId, itemName } = req.body;
        
        const stockHistory = readData(STOCK_HISTORY_FILE);
        const stock = readData(STOCK_FILE);
        
        // Find the entry
        const entryIndex = stockHistory.findIndex(entry => 
            String(entry.id || entry.timestamp || entry.itemName) === String(entryId)
        );
        
        if (entryIndex === -1) {
            return res.status(404).json({
                success: false,
                error: 'Stock history entry not found'
            });
        }
        
        const entry = stockHistory[entryIndex];
        
        // If itemId is provided, verify it exists in stock
        if (itemId) {
            const stockItem = stock.find(item => item.id === itemId);
            if (!stockItem) {
                return res.status(400).json({
                    success: false,
                    error: 'Item ID not found in stock'
                });
            }
            
            entry.itemId = itemId;
            entry.itemName = stockItem.name; // Update name to match stock
        }
        // If only itemName is provided, try to find matching ID
        else if (itemName) {
            const stockItem = stock.find(item => 
                item.name.toLowerCase() === itemName.toLowerCase()
            );
            
            if (stockItem) {
                entry.itemId = stockItem.id;
                entry.itemName = stockItem.name;
            } else {
                entry.itemName = itemName;
            }
        }
        
        // Save the updated entry
        stockHistory[entryIndex] = entry;
        writeData(STOCK_HISTORY_FILE, stockHistory);
        
        res.json({
            success: true,
            message: 'Stock history entry updated successfully',
            entry: entry
        });
        
    } catch (error) {
        console.error('Error updating stock history entry:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update stock history entry'
        });
    }
});
// Add this near your other API endpoints

app.put('/api/loans/:id', (req, res) => {
    try {
        let loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        const idx = loans.findIndex(l => String(l.id) === String(req.params.id));
        if (idx === -1) return res.status(404).json({ error: 'Loan not found' });
        loans[idx] = { ...loans[idx], ...req.body };
        fs.writeFileSync(LOAN_FILE, JSON.stringify(loans, null, 2));
        res.json(loans[idx]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to update loan' });
    }
});
// Add repayment to a loan
app.post('/api/loans/:id/repayments', (req, res) => {
    try {
        const loanId = req.params.id;
        const repayment = req.body;
        
        let loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        const loanIndex = loans.findIndex(l => String(l.id) === String(loanId));
        
        if (loanIndex === -1) {
            return res.status(404).json({ error: 'Loan not found' });
        }
        
        // Add repayment to loan
        if (!loans[loanIndex].repayments) {
            loans[loanIndex].repayments = [];
        }
        loans[loanIndex].repayments.push(repayment);
        
        // Update loan status if fully paid
        const totalPayable = loans[loanIndex].loanAmount * (1 + (loans[loanIndex].interestRate / 100));
        const amountPaid = loans[loanIndex].repayments.reduce((sum, rep) => sum + rep.amount, 0);
        
        if (amountPaid >= totalPayable - 0.01) { // Allow small rounding errors
            loans[loanIndex].status = 'Paid';
            loans[loanIndex].paidDate = new Date().toISOString();
        }
        
        fs.writeFileSync(LOAN_FILE, JSON.stringify(loans, null, 2));
        res.json({ success: true, loan: loans[loanIndex] });
    } catch (e) {
        res.status(500).json({ error: 'Failed to add repayment' });
    }
});

// Get loan by ID
app.get('/api/loans/:id', (req, res) => {
    try {
        const loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        const loan = loans.find(l => String(l.id) === String(req.params.id));
        
        if (!loan) {
            return res.status(404).json({ error: 'Loan not found' });
        }
        
        res.json(loan);
    } catch (e) {
        res.status(500).json({ error: 'Failed to get loan' });
    }
});

// Delete a loan
app.delete('/api/loans/:id', (req, res) => {
    try {
        let loans = JSON.parse(fs.readFileSync(LOAN_FILE, 'utf8'));
        loans = loans.filter(l => String(l.id) !== String(req.params.id));
        fs.writeFileSync(LOAN_FILE, JSON.stringify(loans, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete loan' });
    }
});
// WebSocket connection handling
ws.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Identify user
            if (data.type === 'identify' && data.username) {
                ws.username = data.username;
                onlineUsers.set(data.username, ws);

                console.log(`User identified: ${data.username}`);
                broadcastOnlineUsers();
            }

        } catch (e) {
            console.error('Invalid WS message:', msg.toString(), e);
        }
    });

    ws.on('close', () => {
        if (ws.username) {
            onlineUsers.delete(ws.username);
            console.log(`User disconnected: ${ws.username}`);
            broadcastOnlineUsers();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);

        if (ws.username) {
            onlineUsers.delete(ws.username);
            console.log(`User error & disconnected: ${ws.username}`);
            broadcastOnlineUsers();
        }
    });
});

// Add this function to scan for customer names across all data files
function scanAllCustomerNames() {
    try {
        console.log("🔍 Scanning for all customer names across data files...");
        
        const customerNames = new Set();
        
        // Scan sales.json
        try {
            const sales = readData(SALES_FILE);
            sales.forEach(sale => {
                if (sale.customerName && sale.customerName.trim() && sale.customerName !== 'Tapez le nom du client') {
                    customerNames.add(sale.customerName.trim());
                }
                // Check hybrid breakdown for customer name
                if (sale.hybridBreakdown && sale.hybridBreakdown.customerName) {
                    customerNames.add(sale.hybridBreakdown.customerName.trim());
                }
            });
            console.log(`   📊 Sales: Found ${sales.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading sales:", e.message);
        }
        
        // Scan credit sales
        try {
            const creditSales = readData(CREDIT_SALES_FILE);
            creditSales.forEach(sale => {
                if (sale.customerName && sale.customerName.trim()) {
                    customerNames.add(sale.customerName.trim());
                }
            });
            console.log(`   💳 Credit Sales: Found ${creditSales.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading credit sales:", e.message);
        }
        
        // Scan customer receipts
        try {
            const customerReceipts = readData(CUSTOMER_RECEIPTS_FILE);
            customerReceipts.forEach(receipt => {
                if (receipt.customerName && receipt.customerName.trim()) {
                    customerNames.add(receipt.customerName.trim());
                }
            });
            console.log(`   🧾 Customer Receipts: Found ${customerReceipts.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading customer receipts:", e.message);
        }
        
        // Convert to sorted array
        const sortedNames = Array.from(customerNames).sort();
        
        console.log(`✅ Found ${sortedNames.length} unique customer names`);
        
        return {
            success: true,
            count: sortedNames.length,
            customers: sortedNames
        };
        
    } catch (error) {
        console.error("❌ Error scanning customer names:", error);
        return {
            success: false,
            error: error.message,
            customers: []
        };
    }
}
// Add this function to scan for customer names AND phone numbers across all data files
function scanAllCustomerNamesAndPhones() {
    try {
        console.log("🔍 Scanning for all customer names and phone numbers across data files...");
        
        const customersMap = new Map(); // Use Map to store unique customers with phone numbers
        
        // Scan sales.json
        try {
            const sales = readData(SALES_FILE);
            sales.forEach(sale => {
                if (sale.customerName && sale.customerName.trim() && sale.customerName !== 'Tapez le nom du client') {
                    const customerKey = sale.customerName.trim().toLowerCase();
                    const existing = customersMap.get(customerKey) || { name: sale.customerName.trim(), phone: '' };
                    
                    // Update phone if available in sale
                    if (sale.customerPhoneNumber && sale.customerPhoneNumber.trim()) {
                        existing.phone = sale.customerPhoneNumber.trim();
                    }
                    
                    customersMap.set(customerKey, existing);
                }
                // Check hybrid breakdown for customer name and phone
                if (sale.hybridBreakdown) {
                    if (sale.hybridBreakdown.customerName && sale.hybridBreakdown.customerName.trim()) {
                        const customerKey = sale.hybridBreakdown.customerName.trim().toLowerCase();
                        const existing = customersMap.get(customerKey) || { 
                            name: sale.hybridBreakdown.customerName.trim(), 
                            phone: '' 
                        };
                        
                        if (sale.hybridBreakdown.customerPhoneNumber && sale.hybridBreakdown.customerPhoneNumber.trim()) {
                            existing.phone = sale.hybridBreakdown.customerPhoneNumber.trim();
                        }
                        
                        customersMap.set(customerKey, existing);
                    }
                }
            });
            console.log(`   📊 Sales: Found ${sales.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading sales:", e.message);
        }
        
        // Scan credit sales
        try {
            const creditSales = readData(CREDIT_SALES_FILE);
            creditSales.forEach(sale => {
                if (sale.customerName && sale.customerName.trim()) {
                    const customerKey = sale.customerName.trim().toLowerCase();
                    const existing = customersMap.get(customerKey) || { 
                        name: sale.customerName.trim(), 
                        phone: '' 
                    };
                    
                    if (sale.customerPhoneNumber && sale.customerPhoneNumber.trim()) {
                        existing.phone = sale.customerPhoneNumber.trim();
                    }
                    
                    customersMap.set(customerKey, existing);
                }
            });
            console.log(`   💳 Credit Sales: Found ${creditSales.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading credit sales:", e.message);
        }
        
        // Scan customer receipts
        try {
            const customerReceipts = readData(CUSTOMER_RECEIPTS_FILE);
            customerReceipts.forEach(receipt => {
                if (receipt.customerName && receipt.customerName.trim()) {
                    const customerKey = receipt.customerName.trim().toLowerCase();
                    const existing = customersMap.get(customerKey) || { 
                        name: receipt.customerName.trim(), 
                        phone: '' 
                    };
                    
                    if (receipt.customerPhoneNumber && receipt.customerPhoneNumber.trim()) {
                        existing.phone = receipt.customerPhoneNumber.trim();
                    }
                    
                    customersMap.set(customerKey, existing);
                }
            });
            console.log(`   🧾 Customer Receipts: Found ${customerReceipts.length} records`);
        } catch (e) {
            console.warn("   ⚠️ Error reading customer receipts:", e.message);
        }
        
        // Convert to sorted array
        const customers = Array.from(customersMap.values())
            .sort((a, b) => a.name.localeCompare(b.name));
        
        console.log(`✅ Found ${customers.length} unique customers with phone numbers`);
        
        return {
            success: true,
            count: customers.length,
            customers: customers
        };
        
    } catch (error) {
        console.error("❌ Error scanning customer names and phones:", error);
        return {
            success: false,
            error: error.message,
            customers: []
        };
    }
}

// Update the existing scanAllCustomerNames function to use the new version
app.get('/api/customers/scan-all', (req, res) => {
    try {
        const result = scanAllCustomerNamesAndPhones(); // Changed to new function
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Failed to scan customer names"
        });
    }
});

// Update the customer search API to include phone numbers
app.get('/api/customers/search/:query', (req, res) => {
    try {
        const query = req.params.query.toLowerCase();
        const allCustomers = scanAllCustomerNamesAndPhones(); // Changed to new function
        
        if (!allCustomers.success) {
            return res.json({
                success: false,
                customers: []
            });
        }
        
        // Search in both name and phone number
        const filteredCustomers = allCustomers.customers.filter(customer => 
            customer.name.toLowerCase().includes(query) ||
            customer.phone.includes(query)
        );
        
        res.json({
            success: true,
            count: filteredCustomers.length,
            customers: filteredCustomers.slice(0, 50) // Limit results
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Failed to search customers"
        });
    }
});
// Get transactions for a specific customer
function getCustomerTransactions(customerName) {
    try {
        console.log(`🔍 Getting all transactions for customer: ${customerName}`);
        
        const allTransactions = [];
        
        // Get from sales
        const sales = readData(SALES_FILE);
        const customerSales = sales.filter(sale => {
            // Check main customer name
            if (sale.customerName && sale.customerName.trim() === customerName) {
                return true;
            }
            // Check hybrid breakdown
            if (sale.hybridBreakdown && sale.hybridBreakdown.customerName === customerName) {
                return true;
            }
            return false;
        });
        
        // Add sales to transactions
        customerSales.forEach(sale => {
            allTransactions.push({
                type: 'sale',
                id: sale.id || `SALE-${Date.now()}`,
                date: sale.dateSold || sale.timestamp || new Date().toISOString(),
                productName: sale.productName,
                quantity: sale.quantity,
                total: sale.originalTotal || sale.price,
                paymentType: sale.paymentType,
                status: 'completed',
                data: sale
            });
        });
        
        // Get from credit sales
        const creditSales = readData(CREDIT_SALES_FILE);
        const customerCredits = creditSales.filter(sale => 
            sale.customerName && sale.customerName.trim() === customerName
        );
        
        customerCredits.forEach(sale => {
            allTransactions.push({
                type: 'credit',
                id: sale.id || `CREDIT-${Date.now()}`,
                date: sale.dateSold || sale.timestamp || new Date().toISOString(),
                productName: sale.productName,
                quantity: sale.quantity,
                total: sale.originalTotal || sale.price,
                paymentType: sale.paymentType,
                status: sale.status || 'pending',
                balanceDue: sale.creditBalance || 0,
                data: sale
            });
        });
        
        // Get from customer receipts
        const customerReceipts = readData(CUSTOMER_RECEIPTS_FILE);
        const customerReceiptTransactions = customerReceipts.filter(receipt => 
            receipt.customerName && receipt.customerName.trim() === customerName
        );
        
        customerReceiptTransactions.forEach(receipt => {
            allTransactions.push({
                type: 'receipt',
                id: receipt.receiptId || `RECEIPT-${Date.now()}`,
                date: receipt.date || receipt.createdAt || new Date().toISOString(),
                productName: receipt.items && receipt.items.length > 0 
                    ? receipt.items.map(item => item.name).join(', ') 
                    : 'Multiple Items',
                quantity: receipt.items ? receipt.items.length : 1,
                total: receipt.total || 0,
                paymentType: receipt.paymentType || 'Unknown',
                status: 'completed',
                data: receipt
            });
        });
        
        // Sort by date (newest first)
        allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        console.log(`✅ Found ${allTransactions.length} transactions for ${customerName}`);
        
        return {
            success: true,
            customerName,
            transactionCount: allTransactions.length,
            transactions: allTransactions,
            summary: {
                totalSales: customerSales.length,
                totalCredits: customerCredits.length,
                totalReceipts: customerReceiptTransactions.length,
                totalAmount: allTransactions.reduce((sum, t) => sum + (parseFloat(t.total) || 0), 0)
            }
        };
        
    } catch (error) {
        console.error("❌ Error getting customer transactions:", error);
        return {
            success: false,
            error: error.message,
            transactions: []
        };
    }
}



// API endpoint to get customer transactions
app.get('/api/customers/:name/transactions', (req, res) => {
    try {
        const customerName = decodeURIComponent(req.params.name);
        const result = getCustomerTransactions(customerName);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Failed to get customer transactions"
        });
    }
});


// Add this function in server.js to create license file with creation date
function createLicenseFileWithDate(data = {}) {
    // Always create as an array with initialization entry
    const licenseData = [
        {
            status: "initialized",
            initializedAt: new Date().toISOString(),
            createdDate: new Date().toISOString(),
            createdTimestamp: Date.now().toString()
        }
    ];
    
    // Add activation data if provided
    if (data.type) {
        licenseData.push(data);
    }
    
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2));
    console.log(`📅 License file created with history format`);
    return licenseData;
}
// Add this function to initialize license file
function initializeLicenseFile() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) {
            console.log("📄 Creating initial license file with history format");
            createLicenseFileWithDate(); // Creates initialization entry only
        } else {
            // Check and convert old format to new array format
            const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
            
            // If it's an object (old format), convert to array
            if (!Array.isArray(data)) {
                console.log("🔄 Converting old license format to history array");
                let newData = [];
                
                if (data.initializedAt) {
                    newData.push({
                        status: "initialized",
                        initializedAt: data.initializedAt,
                        createdDate: data.createdDate || data.initializedAt,
                        createdTimestamp: data.createdTimestamp || Date.now().toString()
                    });
                } else {
                    // Add initialization entry
                    newData.push({
                        status: "initialized",
                        initializedAt: new Date().toISOString(),
                        createdDate: new Date().toISOString(),
                        createdTimestamp: Date.now().toString()
                    });
                }
                
                // Add existing activation if present
                if (data.type) {
                    newData.push(data);
                }
                
                fs.writeFileSync(LICENSE_FILE, JSON.stringify(newData, null, 2));
                console.log("✅ Converted to history format");
            }
        }
    } catch (error) {
        console.error("Error initializing license file:", error);
    }
}


app.post('/api/settings/email', (req, res) => {
    try {
        const settings = req.body;
        
        // Ensure alertTypes exists
        if (!settings.alertTypes) {
            settings.alertTypes = {
                lowStock: false,
                restock: false,
                expiry: false
            };
        }
        
        // Save settings
        fs.writeFileSync(EMAIL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
        
        console.log('✅ Email settings saved:', settings);
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Error saving email settings:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to save email settings' 
        });
    }
});

app.get('/api/settings/email', (req, res) => {
    res.json(JSON.parse(fs.readFileSync(EMAIL_SETTINGS_FILE, 'utf8')));
});

// Add this route in your server file
app.post('/api/send-welcome-email', async (req, res) => {
    try {
        const { userData, businessInfo, selectedLanguage } = req.body;
        
        console.log('📧 API: Sending welcome email request received');
        
        await sendWelcomeEmail(userData, businessInfo, selectedLanguage);
        
        res.status(200).json({ 
            success: true, 
            message: 'Welcome email sent successfully' 
        });
        
    } catch (error) {
        console.error('❌ API: Error sending welcome email:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send welcome email' 
        });
    }
});
function isSetupComplete() {
    try {
        const SETUP_FILE = path.join(baseDataPath, 'MEMORY', 'setup.json');
        if (fs.existsSync(SETUP_FILE)) {
            const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
            return !setup.isFirstTime && setup.completedAt;
        }
        return false;
    } catch (error) {
        console.error('Error checking setup status:', error);
        return false;
    }
}


async function checkLicenseExpirationAndNotify() {
    console.log("🕵️ Checking license status for automated notifications...");
    
    if (!fs.existsSync(LICENSE_FILE)) {
        console.log("ℹ️ No license file found. Skipping checks.");
        return;
    }

    try {
        let licenseDataArray = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        
        // Ensure we are working with an array
        if (!Array.isArray(licenseDataArray)) {
            licenseDataArray = [licenseDataArray];
        }

        // Get the latest activation (ignoring the initialization entry usually at index 0)
        const activeLicense = licenseDataArray
            .filter(item => item.type && (item.type === 'Monthly' || item.type === 'Yearly'))
            .pop();

        if (!activeLicense) {
            console.log("ℹ️ No active Monthly/Yearly license found.");
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const expiryDate = new Date(activeLicense.nextToactvate);
        expiryDate.setHours(0, 0, 0, 0);

        // Calculate difference in days
        const diffTime = expiryDate - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        let status = null;

        if (diffDays < 0) {
            status = 'expired';
        } else if (diffDays === 0) {
            status = 'today';
        } else if (diffDays <= 3) {
            status = 'warning';
        }

        if (status) {
            console.log(`⚠️ License condition detected: ${status} (${diffDays} days remaining)`);

            // CHECK: Don't spam. Check if we already sent an email TODAY.
            const todayStr = new Date().toISOString().split('T')[0];
            
            if (activeLicense.lastReminderSentDate === todayStr) {
                console.log("✋ Reminder already sent today. Skipping.");
                return;
            }

            // Send Email
            const sent = await sendLicenseReminderEmail(activeLicense, status, diffDays);

            if (sent) {
                // Update the license file with the last reminder date
                activeLicense.lastReminderSentDate = todayStr;
                
                // Update the specific item in the array
                const index = licenseDataArray.findIndex(item => item.activatedAt === activeLicense.activatedAt);
                if (index !== -1) {
                    licenseDataArray[index] = activeLicense;
                    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseDataArray, null, 2));
                    console.log("💾 Updated license file with reminder date.");
                }
            }
        } else {
            console.log(`✅ License is healthy. ${diffDays} days remaining.`);
        }

    } catch (error) {
        console.error("❌ Error in automated license check:", error);
    }
}
// Add this function in server.js (near other helper functions)
async function getCityFromCoordinates(lat, lng) {
    try {
        // Use OpenStreetMap Nominatim for reverse geocoding (free)
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
            headers: {
                'User-Agent': 'StockApp/1.0' // Required by Nominatim
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.address) {
                return {
                    city: data.address.city || data.address.town || data.address.village || data.address.county || 'Unknown',
                    country: data.address.country || 'Unknown',
                    countryCode: data.address.country_code || '',
                    state: data.address.state || data.address.region || '',
                    postcode: data.address.postcode || '',
                    fullAddress: data.display_name || ''
                };
            }
        }
    } catch (error) {
        console.warn('Reverse geocoding failed:', error.message);
    }
    return null;
}
app.post('/api/send-verification', async (req, res) => {
    const { email, location } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Get server-side location info
    const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
    const geo = geoip.lookup(userIP);
    
    let userLocation = {
        ip: userIP,
        city: geo ? geo.city : 'Unknown',
        country: geo ? geo.country : 'Unknown',
        region: geo ? geo.region : 'Unknown',
        timezone: geo ? geo.timezone : 'Unknown',
        coordinates: geo ? geo.ll : null,
        device: req.headers['user-agent'] || 'Unknown device',
        detectedAt: new Date().toISOString()
    };
    
    // If client sent coordinates, use them and try to get city name
    if (location && location.latitude && location.longitude) {
        console.log('📍 Using client coordinates for location:', location.latitude, location.longitude);
        
        // Try to get city name from coordinates
        const reverseGeocode = await getCityFromCoordinates(location.latitude, location.longitude);
        
        if (reverseGeocode) {
            userLocation = {
                ...userLocation,
                ...reverseGeocode,
                coordinates: [location.latitude, location.longitude],
                accuracy: location.accuracy || null,
                source: 'browser-geolocation',
                hasExactCoordinates: true
            };
            console.log('📍 Reverse geocoded to:', reverseGeocode.city, reverseGeocode.country);
        } else {
            // Use coordinates even if we can't get city name
            userLocation = {
                ...userLocation,
                coordinates: [location.latitude, location.longitude],
                source: 'browser-geolocation',
                hasExactCoordinates: true,
                note: 'Exact coordinates available'
            };
        }
    } else if (location && location.city) {
        // Use client-reported city if available
        userLocation = {
            ...userLocation,
            ...location,
            source: 'client-reported'
        };
    }
    
    verificationCodes.set(email, { 
        code, 
        expires: Date.now() + 10 * 60 * 1000,
        location: userLocation
    });

    try {
        await sendVerificationCode(email, code, userLocation);
        
        res.json({ 
            success: true, 
            message: "Verification code sent successfully",
            locationDetected: true,
            hasExactCoordinates: !!(location && location.latitude),
            city: userLocation.city,
            country: userLocation.country,
            coordinates: userLocation.coordinates,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error("Mail Error:", error);
        res.status(500).json({ error: "Failed to send verification email" });
    }
});

// API to Verify the Code
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;
    const data = verificationCodes.get(email);

    if (data && data.code === code && data.expires > Date.now()) {
        // Optional: Log verification with location
        console.log(`✅ Code verified for ${email} from ${data.location.city || 'unknown location'}`);
        
        verificationCodes.delete(email); // Clear code after success
        res.json({ 
            success: true,
            verifiedAt: new Date().toISOString(),
            location: data.location
        });
    } else {
        res.status(400).json({ 
            success: false, 
            message: "Invalid or expired code" 
        });
    }
});;

// Add this endpoint to server.js
// In server.js, make sure the /api/user-location endpoint is working
app.get('/api/user-location', (req, res) => {
    try {
        const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
        console.log('📍 User IP for location:', userIP);
        
        const geo = geoip.lookup(userIP);
        
        const locationData = {
            ip: userIP,
            city: geo ? geo.city : 'Unknown',
            country: geo ? geo.country : 'Unknown',
            region: geo ? geo.region : 'Unknown',
            timezone: geo ? geo.timezone : 'Unknown',
            coordinates: geo ? geo.ll : null,
            metro: geo ? geo.metro : null,
            range: geo ? geo.range : null,
            device: req.headers['user-agent'] || 'Unknown device',
            timestamp: new Date().toISOString(),
            success: !!geo
        };
        
        console.log('📍 Location data for IP:', locationData);
        res.json(locationData);
        
    } catch (error) {
        console.error('❌ Error getting user location:', error);
        res.json({
            ip: 'unknown',
            city: 'Unknown',
            country: 'Unknown',
            error: error.message,
            timestamp: new Date().toISOString(),
            success: false
        });
    }
});
// - Based on file handling patterns in server.js
function migrateStockHasBeenSold() {
    console.log("🔄 Starting migration: Marking items as 'hasBeenSold' based on history...");
    
    try {
        const stock = readData(STOCK_FILE);
        const sales = readData(SALES_FILE);
        const history = readData(STOCK_HISTORY_FILE);
        
        let updatedCount = 0;
        
        // Create a set of all product names/IDs that have ever been sold
        const soldItemIds = new Set();
        const soldItemNames = new Set();
        
        // 1. Check Sales Log
        sales.forEach(sale => {
            if (sale.itemId) soldItemIds.add(String(sale.itemId));
            if (sale.productName) soldItemNames.add(sale.productName.toLowerCase().trim());
        });

        // 2. Check Stock History (for "Item Sold" actions)
        history.forEach(entry => {
            if (entry.action === "Item Sold" || entry.action === "Sale Recorded") {
                if (entry.itemId) soldItemIds.add(String(entry.itemId));
                if (entry.itemName) soldItemNames.add(entry.itemName.toLowerCase().trim());
            }
        });

        // 3. Update Stock
        stock.forEach(item => {
            // If item is already marked, skip
            if (item.hasBeenSold === true) return;

            // Check if this item exists in our "sold" lists
            const idMatch = item.id && soldItemIds.has(String(item.id));
            const nameMatch = item.name && soldItemNames.has(item.name.toLowerCase().trim());

            if (idMatch || nameMatch) {
                item.hasBeenSold = true;
                updatedCount++;
            } else {
                // Optional: Explicitly set to false if not sold, to be clean
                if (item.hasBeenSold === undefined) {
                    item.hasBeenSold = false;
                }
            }
        });

        if (updatedCount > 0) {
            writeData(STOCK_FILE, stock);
            console.log(`✅ Migration complete: Marked ${updatedCount} old items as 'hasBeenSold'.`);
        } else {
            console.log("ℹ️ Migration complete: No new items needed marking.");
        }

    } catch (error) {
        console.error("❌ Migration failed:", error);
    }
}

// --- AUTOMATIC EMAIL SCHEDULER ENGINE ---
async function runEmailScheduler() {
    console.log("⏰ Running email scheduler check...");
    try {
        const SCHEDULE_FILE = path.join(userDataPath, 'emailSchedule.json');
        const LOG_FILE = path.join(userDataPath, 'emailScheduleLog.json');

        if (!fs.existsSync(SCHEDULE_FILE)) return;

        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        
        // 1. If Disabled, don't run
        if (!schedule.enabled) return;

        // 2. Determine how many days to wait based on frequency
        let daysToWait = 1;
        if (schedule.frequency === 'every3days') daysToWait = 3;
        if (schedule.frequency === 'weekly') daysToWait = 7;

        // 3. Check the Log to see when we last sent
        let lastSentDate = new Date(0); // Default to a long time ago
        if (fs.existsSync(LOG_FILE)) {
            const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
            const timestamps = [];
            Object.values(log).forEach(day => {
                if (day.manualSend?.timestamp) timestamps.push(new Date(day.manualSend.timestamp));
                if (day.autoSend?.timestamp) timestamps.push(new Date(day.autoSend.timestamp));
            });
            if (timestamps.length > 0) {
                lastSentDate = new Date(Math.max(...timestamps));
            }
        }

        // 4. Check if it is time to send (Is current time > lastSent + daysToWait?)
        const nextDueTime = new Date(lastSentDate);
        nextDueTime.setDate(lastSentDate.getDate() + daysToWait);

        if (new Date() >= nextDueTime) {
            console.log("⏰ Schedule Due! Running automated inventory check...");
            
            // Trigger the internal logic (Same as your /api/send-emails-now)
            const stock = readData(STOCK_FILE);
            const sales = readData(SALES_FILE);
            
            const lowStockItems = stock.filter(item => item.quantity <= 3 && item.hasBeenSold);
            if (lowStockItems.length > 0) await sendLowStockAlert(lowStockItems);
            await sendSmartRestockRecommendations(stock, sales);

            // 5. Log the Auto-Send so the UI updates
            let log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : {};
            const today = new Date().toISOString().split('T')[0];
            log[today] = log[today] || {};
            log[today].autoSend = {
                timestamp: new Date().toISOString(),
                count: lowStockItems.length
            };
            fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
            console.log("✅ Automated emails sent and logged.");
        }
    } catch (error) {
        console.error("❌ Scheduler Error:", error.message);
    }
}




function initializeScheduler() {
    if (schedulerInitialized) {
        console.log("⏭️ Scheduler already initialized, skipping...");
        return;
    }
    schedulerInitialized = true;

    console.log("🛠️ Initializing Production Scheduler...");
    
    // Check if shortcut exists, if not, create it (Startup folder)
    enableAutoStart(); 

    // Run a check immediately
    checkAndSendScheduledEmails();

    // Set the heartbeat (check once per hour)
    setInterval(checkAndSendScheduledEmails, 3600000);
}
// Start the logic
initializeScheduler();
function initializeServer() {
    console.log("🚀 Starting server initialization...");
    
checkSingleInstance();
ensureLogoInAppData();
runEmailScheduler();


    ensureStockHasIds();
    console.log("✅ Stock ID check completed");
    removeAllQRCodesFromStock();
    console.log("✅ QR code cleanup completed");
       initializeLicenseFile();
    // 2. Fix stock history item IDs
    updateStockHistoryWithItemIds();
    updateSalesWithStockIdsAndAggregate();

    console.log("✅ Stock history ID fix completed");
    migrateStockHasBeenSold();
  
  
    // 3. Fix missing sale dates (optional)
    try {
        const sales = readData(SALES_FILE);
        let fixedCount = 0;
        
        sales.forEach(sale => {
            if (!sale.dateSold || sale.dateSold.trim() === "") {
                if (sale.timestamp) {
                    const datePart = sale.timestamp.split(" ")[0];
                    const parts = datePart.split("/");
                    if (parts.length === 3) {
                        const [day, month, year] = parts;
                        sale.dateSold = `${year}-${month}-${day}`;
                        fixedCount++;
                    }
                }
            }
        });
        
        if (fixedCount > 0) {
            writeData(SALES_FILE, sales);
            console.log(`✅ Fixed ${fixedCount} sale records missing dateSold`);
        }
    } catch (error) {
        console.warn("⚠️ Could not fix missing sale dates:", error.message);
    }
    
    console.log("🎯 Server initialization complete!");
}

// Call initialization before starting the server
initializeServer();
setTimeout(() => scheduler.checkAndSend(), 15000);
setInterval(() => scheduler.checkAndSend(), 60 * 60 * 1000);
// Check every hour (3600000 ms)
setInterval(runEmailScheduler, 3600000);

const bonjour = require('bonjour')();
// Start the server
server.listen(PORT, '0.0.0.0', () => {
  const currentIp = getLocalNetworkIP();
  
  console.log(`✅ StockApp Server is running!`);
  console.log(`========================================`);
  console.log(`🌐 LOCAL ACCESS (Primary):`);
  console.log(`   🔗 https://localhost:${PORT}`);
  console.log(`\n📱 NETWORK ACCESS (Optional):`);
  console.log(`   🔗 https://${currentIp}:${PORT}`);
  console.log(`========================================`);
  
  if (bonjour && currentIp !== '127.0.0.1') {
    bonjour.publish({
      name: 'StockApp Server',
      type: 'https',
      port: PORT.toString(),
      host: currentIp,
      protocol: 'tcp',
      subtypes: ['StockApp'],
      txt: {
        version: '1.0',
        path: '/shop.html',
        localhost: `https://localhost:${PORT}`
      }
    });
  }
});