const path = require('path');
process.env.EDGE_USE_CORECLR = 1;
process.env.EDGE_APP_ROOT = path.join(__dirname, '/src/QuickStart.Core/bin/Debug/net7.0')