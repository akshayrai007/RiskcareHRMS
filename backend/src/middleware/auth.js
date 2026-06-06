// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const db  = require('../config/db');

exports.authenticate = async (req, res, next) => {
  try {
    // Support token in Authorization header OR as ?token= query param (for browser-opened previews)
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      token = header.split(' ')[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token)
      return res.status(401).json({ success: false, message: 'No token provided' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'hrms_secret');

    const result = await db.query(
      `SELECT e.*,
              d.name AS department_name, des.title AS designation_title,
              CONCAT(m.first_name,' ',m.last_name) AS manager_name,
              TO_CHAR(e.joining_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS joining_date,
              TO_CHAR(e.date_of_birth AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date_of_birth
       FROM employees e
       LEFT JOIN departments d ON e.department_id=d.id
       LEFT JOIN designations des ON e.designation_id=des.id
       LEFT JOIN employees m ON e.reporting_manager_id=m.id
       WHERE e.id=$1 AND e.is_active=true`,
      [decoded.id]
    );

    if (!result.rows.length)
      return res.status(401).json({ success: false, message: 'User not found or inactive' });

    req.user = result.rows[0];
    req.user.role = req.user.role?.toLowerCase().trim(); // normalize role casing
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, message: 'Token expired' });
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

exports.authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role))
    return res.status(403).json({ success: false, message: `Access denied. Required: ${roles.join(' or ')}` });
  next();
};
