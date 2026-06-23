require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const { exec } = require('child_process');
const pool    = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Servir el frontend estático ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../front-end')));

// ─── Middleware: verificar JWT en todas las rutas /api ────────────────────────
function auth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1]; // "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión inválida o expirada. Volvé a iniciar sesión.' });
  }
}

// ─── POST /api/login ──────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });

  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) return res.status(500).json({ error: 'Contraseña no configurada en el servidor' });

  const ok = bcrypt.compareSync(password, hash);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const token = jwt.sign({ app: 'vacaciones' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 28800 }); // 8 horas en segundos
});

// ─── POST /api/cambiar-password ──────────────────────────────────────────────
app.post('/api/cambiar-password', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { jwt.verify(token, process.env.JWT_SECRET); } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  const { nueva } = req.body;
  if (!nueva || nueva.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const hash = bcrypt.hashSync(nueva, 10);
  const envPath = path.join(__dirname, '.env');

  try {
    let contenido = fs.readFileSync(envPath, 'utf8');
    if (/^APP_PASSWORD_HASH=.*/m.test(contenido)) {
      contenido = contenido.replace(/^APP_PASSWORD_HASH=.*/m, `APP_PASSWORD_HASH=${hash}`);
    } else {
      contenido += `\nAPP_PASSWORD_HASH=${hash}`;
    }
    fs.writeFileSync(envPath, contenido, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo actualizar el archivo .env: ' + err.message });
  }

  // Actualizar en memoria para que el nuevo hash funcione de inmediato
  process.env.APP_PASSWORD_HASH = hash;

  // Reiniciar con PM2 en segundo plano (si está disponible)
  exec('pm2 restart all', (err) => {
    if (err) console.warn('PM2 no disponible o error al reiniciar:', err.message);
  });

  res.json({ message: 'Contraseña actualizada correctamente. La sesión actual sigue activa.' });
});

// ─── Todas las rutas /api requieren autenticación ─────────────────────────────
app.use('/api', auth);

// ─── GET todos los empleados ──────────────────────────────────────────────────
app.get('/api/empleados', async (req, res) => {
  const { q, dependencia } = req.query;
  let query = `
    SELECT id, region, dependencia, nombre_apellido, dni,
           dias_totales, dias_tomados,
           (dias_totales - dias_tomados) AS saldo_disponible
    FROM empleados WHERE 1=1
  `;
  const params = [];

  if (q) {
    params.push(`%${q.toUpperCase()}%`);
    query += ` AND (UPPER(nombre_apellido) LIKE $${params.length} OR dni LIKE $${params.length})`;
  }
  if (dependencia) {
    params.push(dependencia);
    query += ` AND dependencia = $${params.length}`;
  }
  query += ' ORDER BY dependencia, nombre_apellido';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST crear empleado ──────────────────────────────────────────────────────
app.post('/api/empleados', async (req, res) => {
  const { nombre_apellido, dni, dependencia, region, dias_totales } = req.body;
  if (!nombre_apellido || !dni || !dependencia || !dias_totales)
    return res.status(400).json({ error: 'Nombre, DNI, dependencia y días totales son obligatorios' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO empleados (nombre_apellido, dni, dependencia, region, dias_totales, dias_tomados)
       VALUES ($1, $2, $3, $4, $5, 0)
       RETURNING id, region, dependencia, nombre_apellido, dni, dias_totales, dias_tomados,
                 (dias_totales - dias_tomados) AS saldo_disponible`,
      [nombre_apellido.toUpperCase(), dni, dependencia.toUpperCase(), (region || 'CORDOBA').toUpperCase(), dias_totales]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un empleado con ese DNI' });
    res.status(500).json({ error: err.message });
  }
});

// ─── GET empleado por ID ──────────────────────────────────────────────────────
app.get('/api/empleados/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, region, dependencia, nombre_apellido, dni,
              dias_totales, dias_tomados,
              (dias_totales - dias_tomados) AS saldo_disponible
       FROM empleados WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST cargar días de vacaciones ──────────────────────────────────────────
app.post('/api/empleados/:id/vacaciones', async (req, res) => {
  const { dias, descripcion, fecha } = req.body;
  const empleadoId = req.params.id;

  if (!dias || isNaN(dias) || dias <= 0)
    return res.status(400).json({ error: 'La cantidad de días debe ser un número positivo' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT dias_totales, dias_tomados FROM empleados WHERE id = $1 FOR UPDATE',
      [empleadoId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });

    const saldo = rows[0].dias_totales - rows[0].dias_tomados;
    if (dias > saldo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No hay suficiente saldo. Disponible: ${saldo} días` });
    }

    await client.query(
      'UPDATE empleados SET dias_tomados = dias_tomados + $1, updated_at = NOW() WHERE id = $2',
      [dias, empleadoId]
    );
    await client.query(
      'INSERT INTO movimientos (empleado_id, dias, descripcion, fecha) VALUES ($1, $2, $3, $4)',
      [empleadoId, dias, descripcion || null, fecha || new Date().toISOString().split('T')[0]]
    );
    await client.query('COMMIT');

    const updated = await pool.query(
      `SELECT id, region, dependencia, nombre_apellido, dni,
              dias_totales, dias_tomados,
              (dias_totales - dias_tomados) AS saldo_disponible
       FROM empleados WHERE id = $1`,
      [empleadoId]
    );
    res.json({ message: `✅ Se cargaron ${dias} día(s) correctamente`, empleado: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET historial de movimientos ─────────────────────────────────────────────
app.get('/api/empleados/:id/movimientos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, dias, descripcion, fecha, created_at
       FROM movimientos WHERE empleado_id = $1
       ORDER BY fecha DESC, created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET dependencias únicas ──────────────────────────────────────────────────
app.get('/api/dependencias', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT dependencia FROM empleados
       WHERE dependencia IS NOT NULL AND dependencia != ''
       ORDER BY dependencia`
    );
    res.json(rows.map(r => r.dependencia));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET estadísticas ─────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS total_empleados,
             SUM(dias_totales) AS total_dias_asignados,
             SUM(dias_tomados) AS total_dias_tomados,
             SUM(dias_totales - dias_tomados) AS total_saldo
      FROM empleados
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE empleado ──────────────────────────────────────────────────────────
app.delete('/api/empleados/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT nombre_apellido FROM empleados WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Empleado no encontrado' });
    await pool.query('DELETE FROM empleados WHERE id = $1', [req.params.id]);
    res.json({ message: `Empleado ${rows[0].nombre_apellido} eliminado correctamente` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE movimiento (con reversión) ───────────────────────────────────────
app.delete('/api/movimientos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM movimientos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Movimiento no encontrado' });

    const mov = rows[0];
    await client.query(
      'UPDATE empleados SET dias_tomados = GREATEST(0, dias_tomados - $1), updated_at = NOW() WHERE id = $2',
      [mov.dias, mov.empleado_id]
    );
    await client.query('DELETE FROM movimientos WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: `Movimiento eliminado. Se revirtieron ${mov.dias} día(s)` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, '../front-end')));

app.listen(PORT, () => {
  console.log(` Servidor corriendo en http://localhost:${PORT}`);
});