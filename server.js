const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and generous JSON body limit (for canvas base64 signatures)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database setup: PostgreSQL if DATABASE_URL is present, otherwise fallback to local JSON file
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
let usePostgres = false;

const DATA_DIR = path.join(__dirname, 'data');
const JSON_FILE = path.join(DATA_DIR, 'db.json');

// Ensure local data dir exists
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadLocalData() {
  if (fs.existsSync(JSON_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading db.json, initializing empty store', e);
    }
  }
  return { records: [], employees: [], items: [] };
}

function saveLocalData(data) {
  try {
    fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving db.json', e);
  }
}

let inMemoryDb = loadLocalData();

if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' || DATABASE_URL.includes('render.com') 
        ? { rejectUnauthorized: false } 
        : false
    });
    usePostgres = true;
    console.log('PostgreSQL DATABASE_URL detected. Initializing database tables...');
    initPostgres();
  } catch (err) {
    console.error('Failed to initialize PostgreSQL pool, falling back to local file storage:', err);
    usePostgres = false;
  }
} else {
  console.log('No DATABASE_URL found. Running with file-backed JSON storage at', JSON_FILE);
}

async function initPostgres() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS legal_records (
        id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ems_employees (
        id VARCHAR(255) PRIMARY KEY,
        tracking VARCHAR(255),
        agency VARCHAR(255),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ems_items (
        id VARCHAR(255) PRIMARY KEY,
        employee VARCHAR(255),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ems_emp_agency ON ems_employees(agency);
      CREATE INDEX IF NOT EXISTS idx_ems_emp_tracking ON ems_employees(tracking);
    `);
    console.log('PostgreSQL tables initialized successfully.');
  } catch (err) {
    console.error('Error creating PostgreSQL tables:', err);
    usePostgres = false;
  }
}

// ================= API ENDPOINTS =================

// Status & Health Check
app.get('/api/status', async (req, res) => {
  try {
    let empCount = 0;
    let itemCount = 0;
    if (usePostgres) {
      const empRes = await pool.query('SELECT COUNT(*) FROM ems_employees');
      const itemRes = await pool.query('SELECT COUNT(*) FROM ems_items');
      empCount = parseInt(empRes.rows[0].count, 10);
      itemCount = parseInt(itemRes.rows[0].count, 10);
    } else {
      empCount = (inMemoryDb.employees || []).length;
      itemCount = (inMemoryDb.items || []).length;
    }
    res.json({
      ok: true,
      service: 'May Harvest Corporation - Legal Requirements & EMS Backend',
      storage: usePostgres ? 'Render PostgreSQL' : 'Render File Storage',
      counts: { employees: empCount, items: itemCount },
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= LEGAL REQUIREMENTS TRACKER ENDPOINTS =================

// GET all legal records
app.get('/api/records', async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT data FROM legal_records ORDER BY updated_at DESC');
      const records = result.rows.map(r => r.data);
      return res.json({ ok: true, records });
    }
    res.json({ ok: true, records: inMemoryDb.records || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST single legal record (upsert)
app.post('/api/records', async (req, res) => {
  try {
    const record = req.body;
    if (!record || !record.id) {
      return res.status(400).json({ ok: false, error: 'Record object with id is required.' });
    }
    const now = new Date().toISOString();
    record.updatedAt = now;

    if (usePostgres) {
      await pool.query(
        `INSERT INTO legal_records (id, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = NOW()`,
        [record.id, JSON.stringify(record)]
      );
    } else {
      inMemoryDb.records = inMemoryDb.records || [];
      const idx = inMemoryDb.records.findIndex(x => x.id === record.id);
      if (idx >= 0) {
        inMemoryDb.records[idx] = record;
      } else {
        inMemoryDb.records.push(record);
      }
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, record });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE single legal record
app.delete('/api/records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (usePostgres) {
      await pool.query('DELETE FROM legal_records WHERE id = $1', [id]);
    } else {
      inMemoryDb.records = (inMemoryDb.records || []).filter(x => x.id !== id);
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST sync legal records
app.post('/api/sync-records', async (req, res) => {
  try {
    const clientRecords = Array.isArray(req.body.records) ? req.body.records : [];
    if (usePostgres) {
      for (const rec of clientRecords) {
        if (rec && rec.id) {
          await pool.query(
            `INSERT INTO legal_records (id, data, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (id) DO UPDATE SET
               data = EXCLUDED.data,
               updated_at = NOW()`,
            [rec.id, JSON.stringify(rec)]
          );
        }
      }
      const result = await pool.query('SELECT data FROM legal_records ORDER BY updated_at DESC');
      const allRecords = result.rows.map(r => r.data);
      return res.json({ ok: true, records: allRecords });
    } else {
      inMemoryDb.records = inMemoryDb.records || [];
      const map = new Map((inMemoryDb.records || []).map(x => [x.id, x]));
      for (const rec of clientRecords) {
        if (rec && rec.id) map.set(rec.id, rec);
      }
      inMemoryDb.records = Array.from(map.values());
      saveLocalData(inMemoryDb);
      return res.json({ ok: true, records: inMemoryDb.records });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET all employees
app.get('/api/employees', async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT data FROM ems_employees ORDER BY updated_at DESC');
      const employees = result.rows.map(r => r.data);
      return res.json({ ok: true, employees });
    }
    res.json({ ok: true, employees: inMemoryDb.employees || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST single employee (upsert)
app.post('/api/employees', async (req, res) => {
  try {
    const emp = req.body;
    if (!emp || !emp.id) {
      return res.status(400).json({ ok: false, error: 'Employee object with id is required.' });
    }
    const tracking = emp.tracking || '';
    const agency = emp.agency || '';
    const now = new Date().toISOString();
    emp.updatedAt = now;

    if (usePostgres) {
      await pool.query(
        `INSERT INTO ems_employees (id, tracking, agency, data, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO UPDATE SET
           tracking = EXCLUDED.tracking,
           agency = EXCLUDED.agency,
           data = EXCLUDED.data,
           updated_at = NOW()`,
        [emp.id, tracking, agency, JSON.stringify(emp)]
      );
    } else {
      const idx = (inMemoryDb.employees || []).findIndex(x => x.id === emp.id);
      if (idx >= 0) {
        inMemoryDb.employees[idx] = emp;
      } else {
        inMemoryDb.employees = inMemoryDb.employees || [];
        inMemoryDb.employees.push(emp);
      }
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, employee: emp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE single employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (usePostgres) {
      await pool.query('DELETE FROM ems_employees WHERE id = $1', [id]);
    } else {
      inMemoryDb.employees = (inMemoryDb.employees || []).filter(x => x.id !== id);
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET all accountable items
app.get('/api/items', async (req, res) => {
  try {
    if (usePostgres) {
      const result = await pool.query('SELECT data FROM ems_items ORDER BY updated_at DESC');
      const items = result.rows.map(r => r.data);
      return res.json({ ok: true, items });
    }
    res.json({ ok: true, items: inMemoryDb.items || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST accountable item (upsert)
app.post('/api/items', async (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.id) {
      return res.status(400).json({ ok: false, error: 'Item object with id is required.' });
    }
    const emp = item.employee || '';
    if (usePostgres) {
      await pool.query(
        `INSERT INTO ems_items (id, employee, data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET
           employee = EXCLUDED.employee,
           data = EXCLUDED.data,
           updated_at = NOW()`,
        [item.id, emp, JSON.stringify(item)]
      );
    } else {
      const idx = (inMemoryDb.items || []).findIndex(x => x.id === item.id);
      if (idx >= 0) {
        inMemoryDb.items[idx] = item;
      } else {
        inMemoryDb.items = inMemoryDb.items || [];
        inMemoryDb.items.push(item);
      }
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE accountable item
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (usePostgres) {
      await pool.query('DELETE FROM ems_items WHERE id = $1', [id]);
    } else {
      inMemoryDb.items = (inMemoryDb.items || []).filter(x => x.id !== id);
      saveLocalData(inMemoryDb);
    }
    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/sync: bidirectional sync
// Receives client's local records, merges them on the server, and returns the unified state
app.post('/api/sync', async (req, res) => {
  try {
    const clientEmps = Array.isArray(req.body.employees) ? req.body.employees : [];
    const clientItems = Array.isArray(req.body.items) ? req.body.items : [];

    if (usePostgres) {
      // Upsert client records into Postgres
      for (const emp of clientEmps) {
        if (!emp || !emp.id) continue;
        await pool.query(
          `INSERT INTO ems_employees (id, tracking, agency, data, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [emp.id, emp.tracking || '', emp.agency || '', JSON.stringify(emp)]
        );
      }
      for (const item of clientItems) {
        if (!item || !item.id) continue;
        await pool.query(
          `INSERT INTO ems_items (id, employee, data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [item.id, item.employee || '', JSON.stringify(item)]
        );
      }

      // Read back all records
      const empRes = await pool.query('SELECT data FROM ems_employees ORDER BY created_at ASC');
      const itemRes = await pool.query('SELECT data FROM ems_items ORDER BY created_at ASC');
      return res.json({
        ok: true,
        employees: empRes.rows.map(r => r.data),
        items: itemRes.rows.map(r => r.data),
        storage: 'Render PostgreSQL'
      });
    }

    // File/memory fallback: merge non-existent items
    const serverEmpIds = new Set((inMemoryDb.employees || []).map(x => x.id));
    for (const emp of clientEmps) {
      if (emp && emp.id && !serverEmpIds.has(emp.id)) {
        inMemoryDb.employees.push(emp);
        serverEmpIds.add(emp.id);
      }
    }
    const serverItemIds = new Set((inMemoryDb.items || []).map(x => x.id));
    for (const item of clientItems) {
      if (item && item.id && !serverItemIds.has(item.id)) {
        inMemoryDb.items.push(item);
        serverItemIds.add(item.id);
      }
    }
    saveLocalData(inMemoryDb);

    res.json({
      ok: true,
      employees: inMemoryDb.employees || [],
      items: inMemoryDb.items || [],
      storage: 'Render Server Memory/File'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Clear all records (Admin tool)
app.post('/api/clear-all', async (req, res) => {
  try {
    if (usePostgres) {
      await pool.query('DELETE FROM ems_employees');
      await pool.query('DELETE FROM ems_items');
    }
    inMemoryDb = { employees: [], items: [] };
    saveLocalData(inMemoryDb);
    res.json({ ok: true, message: 'All server records cleared successfully.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve static frontend files
app.use(express.static(__dirname));

// Catch-all route to serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`May Harvest Corporation EMS server is listening on port ${PORT}`);
});
