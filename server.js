const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接（从环境变量获取）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 初始化数据库表
async function initTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id SERIAL PRIMARY KEY,
        name TEXT,
        manager TEXT
      );
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE,
        name TEXT,
        supplier TEXT,
        packaging TEXT,
        unitWeight REAL,
        minStock INTEGER,
        shelfLifeMonths INTEGER
      );
      CREATE TABLE IF NOT EXISTS stocks (
        id SERIAL PRIMARY KEY,
        warehouseId INTEGER,
        productId INTEGER,
        client TEXT,
        units REAL,
        totalWeightKg REAL,
        UNIQUE(warehouseId, productId, client)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        type TEXT,
        timestamp TEXT,
        warehouseId INTEGER,
        productId INTEGER,
        client TEXT,
        units REAL,
        totalWeightKg REAL,
        documentNo TEXT,
        batchNo TEXT,
        supplier TEXT,
        inboundReceiptNo TEXT,
        productionDate TEXT,
        whManager TEXT,
        operator TEXT,
        notes TEXT
      );
    `);
    console.log('Database tables ready');
  } catch (err) {
    console.error('Init error:', err);
  } finally {
    client.release();
  }
}
initTables();

// 获取所有仓库
app.get('/api/warehouses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM warehouses');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有产品
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加或更新产品
app.post('/api/products', async (req, res) => {
  const { id, code, name, supplier, packaging, unitWeight, minStock, shelfLifeMonths } = req.body;
  try {
    if (id) {
      await pool.query(
        `UPDATE products SET code=$1, name=$2, supplier=$3, packaging=$4, unitWeight=$5, minStock=$6, shelfLifeMonths=$7 WHERE id=$8`,
        [code, name, supplier, packaging, unitWeight, minStock, shelfLifeMonths, id]
      );
      res.json({ success: true });
    } else {
      const result = await pool.query(
        `INSERT INTO products (code, name, supplier, packaging, unitWeight, minStock, shelfLifeMonths) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [code, name, supplier, packaging, unitWeight, minStock, shelfLifeMonths]
      );
      res.json({ id: result.rows[0].id });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除产品
app.delete('/api/products/:id', async (req, res) => {
  const id = req.params.id;
  try {
    // 检查是否有库存记录
    const stockCheck = await pool.query('SELECT COUNT(*) FROM stocks WHERE productId=$1', [id]);
    if (parseInt(stockCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Product has stock records' });
    }
    const transCheck = await pool.query('SELECT COUNT(*) FROM transactions WHERE productId=$1', [id]);
    if (parseInt(transCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Product has transaction history' });
    }
    await pool.query('DELETE FROM products WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有库存
app.get('/api/stocks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stocks');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取交易记录（支持日期范围）
app.get('/api/transactions', async (req, res) => {
  const { from, to } = req.query;
  let query = 'SELECT * FROM transactions';
  const params = [];
  if (from && to) {
    query += ' WHERE timestamp BETWEEN $1 AND $2';
    params.push(from, to);
  }
  query += ' ORDER BY timestamp DESC';
  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加交易（入库/出库）
app.post('/api/transactions', async (req, res) => {
  const {
    type, timestamp, warehouseId, productId, client, units, totalWeightKg,
    documentNo, batchNo, supplier, inboundReceiptNo, productionDate, whManager, operator, notes
  } = req.body;

  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');
    // 插入交易
    await clientDb.query(
      `INSERT INTO transactions 
       (type, timestamp, warehouseId, productId, client, units, totalWeightKg, documentNo, batchNo, supplier, inboundReceiptNo, productionDate, whManager, operator, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [type, timestamp, warehouseId, productId, client, units, totalWeightKg, documentNo, batchNo, supplier, inboundReceiptNo, productionDate, whManager, operator, notes]
    );

    // 更新库存
    const deltaUnits = (type === 'inbound') ? units : -units;
    const deltaWeight = (type === 'inbound') ? totalWeightKg : -totalWeightKg;
    await clientDb.query(
      `INSERT INTO stocks (warehouseId, productId, client, units, totalWeightKg)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (warehouseId, productId, client) DO UPDATE SET
       units = stocks.units + $4,
       totalWeightKg = stocks.totalWeightKg + $5`,
      [warehouseId, productId, client, deltaUnits, deltaWeight]
    );

    await clientDb.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await clientDb.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    clientDb.release();
  }
});

// 删除交易
app.delete('/api/transactions/:id', async (req, res) => {
  const id = req.params.id;
  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');
    const trans = await clientDb.query('SELECT * FROM transactions WHERE id=$1', [id]);
    if (trans.rows.length === 0) throw new Error('Transaction not found');
    const t = trans.rows[0];
    // 删除交易
    await clientDb.query('DELETE FROM transactions WHERE id=$1', [id]);
    // 反向调整库存
    const deltaUnits = (t.type === 'inbound') ? -t.units : t.units;
    const deltaWeight = (t.type === 'inbound') ? -t.totalWeightKg : t.totalWeightKg;
    await clientDb.query(
      `UPDATE stocks SET units = units + $1, totalWeightKg = totalWeightKg + $2
       WHERE warehouseId=$3 AND productId=$4 AND client=$5`,
      [deltaUnits, deltaWeight, t.warehouseid, t.productid, t.client]
    );
    await clientDb.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await clientDb.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    clientDb.release();
  }
});

// 更新交易
app.put('/api/transactions/:id', async (req, res) => {
  const id = req.params.id;
  const newData = req.body;
  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');
    const oldTrans = await clientDb.query('SELECT * FROM transactions WHERE id=$1', [id]);
    if (oldTrans.rows.length === 0) throw new Error('Transaction not found');
    const old = oldTrans.rows[0];
    // 反向旧交易影响
    const oldDeltaUnits = (old.type === 'inbound') ? -old.units : old.units;
    const oldDeltaWeight = (old.type === 'inbound') ? -old.totalWeightKg : old.totalWeightKg;
    await clientDb.query(
      `UPDATE stocks SET units = units + $1, totalWeightKg = totalWeightKg + $2
       WHERE warehouseId=$3 AND productId=$4 AND client=$5`,
      [oldDeltaUnits, oldDeltaWeight, old.warehouseid, old.productid, old.client]
    );
    // 更新交易记录
    await clientDb.query(
      `UPDATE transactions SET
        type=$1, warehouseId=$2, productId=$3, client=$4, units=$5, totalWeightKg=$6,
        documentNo=$7, batchNo=$8, supplier=$9, whManager=$10, notes=$11
       WHERE id=$12`,
      [newData.type, newData.warehouseId, newData.productId, newData.client,
       newData.units, newData.totalWeightKg, newData.documentNo, newData.batchNo,
       newData.supplier, newData.whManager, newData.notes, id]
    );
    // 应用新交易影响
    const newDeltaUnits = (newData.type === 'inbound') ? newData.units : -newData.units;
    const newDeltaWeight = (newData.type === 'inbound') ? newData.totalWeightKg : -newData.totalWeightKg;
    await clientDb.query(
      `UPDATE stocks SET units = units + $1, totalWeightKg = totalWeightKg + $2
       WHERE warehouseId=$3 AND productId=$4 AND client=$5`,
      [newDeltaUnits, newDeltaWeight, newData.warehouseId, newData.productId, newData.client]
    );
    await clientDb.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await clientDb.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    clientDb.release();
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
