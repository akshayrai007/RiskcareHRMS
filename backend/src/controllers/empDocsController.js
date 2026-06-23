const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/emp-documents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10*1024*1024 } });
exports.upload = upload;

const DOCUMENT_TYPES = [
  'Passport size photograph','Appointment Letter (Acknowledgement)',
  'Aadhaar Card','PAN Card','Proof of ID & Residence',
  '10th Marksheet / Certificate','12th Marksheet / Certificate',
  'Graduation Marksheet','Post Graduation Certificate','Qualification Certificate',
  'Last 3 Months Pay Slips','Bank Statement / Cancelled Cheque',
  'Previous Employment Certificate','Relieving Letter',
  'Broker Qualification & Renewal Certificate','Broker Training Certificate','Other',
];

async function ensureTables() {
  await db.query(`CREATE TABLE IF NOT EXISTS employee_previous_employment (
    id SERIAL PRIMARY KEY, employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    company_name VARCHAR(200) NOT NULL, company_address TEXT,
    city VARCHAR(100), state VARCHAR(100), from_date DATE, to_date DATE,
    designation VARCHAR(150), job_type VARCHAR(50) DEFAULT 'Full Time',
    prev_manager_name VARCHAR(150), prev_manager_phone VARCHAR(20), prev_manager_email VARCHAR(150),
    prev_hr_name VARCHAR(150), prev_hr_phone VARCHAR(20), prev_hr_email VARCHAR(150),
    pf_number VARCHAR(80), reason_for_leaving TEXT,
    is_overseas BOOLEAN DEFAULT FALSE, is_relevant BOOLEAN DEFAULT FALSE,
    created_by INT, created_at TIMESTAMP DEFAULT NOW()
  )`).catch(()=>{});
  await db.query(`CREATE TABLE IF NOT EXISTS employee_qualifications (
    id SERIAL PRIMARY KEY, employee_id INT REFERENCES employees(id) ON DELETE CASCADE,
    qualification VARCHAR(100) NOT NULL, degree VARCHAR(150), specialization VARCHAR(150),
    institute_name VARCHAR(200) NOT NULL, board_university VARCHAR(200),
    mode_of_education VARCHAR(50), state_location VARCHAR(100), grade_percentage VARCHAR(50),
    passing_month INT, passing_year INT, academic_achievements TEXT, remarks TEXT,
    is_highest BOOLEAN DEFAULT FALSE, created_by INT, created_at TIMESTAMP DEFAULT NOW()
  )`).catch(()=>{});
}

exports.getDocumentTypes = (req, res) => res.json({ success: true, data: DOCUMENT_TYPES });

exports.getDocuments = async (req, res) => {
  try {
    const empId = req.params.employee_id || req.user.id;
    if (parseInt(empId) !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const result = await db.query(
      `SELECT d.*, CONCAT(u.first_name,' ',u.last_name) AS uploaded_by_name
       FROM employee_documents d LEFT JOIN employees u ON u.id = d.uploaded_by
       WHERE d.employee_id=$1 ORDER BY d.document_type, d.uploaded_at DESC`, [empId]);
    const map = {}; for (const t of DOCUMENT_TYPES) map[t] = [];
    for (const r of result.rows) { if (!map[r.document_type]) map[r.document_type]=[]; map[r.document_type].push(r); }
    res.json({ success: true, data: map, list: result.rows, types: DOCUMENT_TYPES });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.uploadDocument = async (req, res) => {
  try {
    const empId = parseInt(req.body.employee_id || req.user.id);
    const docType = req.body.document_type;
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, message: 'No file' });
    if (!docType) return res.status(400).json({ success: false, message: 'Type required' });
    if (empId !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const result = await db.query(
      `INSERT INTO employee_documents (employee_id,document_type,file_name,file_path,uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [empId, docType, file.originalname, '/uploads/emp-documents/'+file.filename, req.user.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteDocument = async (req, res) => {
  try {
    const doc = await db.query(`SELECT * FROM employee_documents WHERE id=$1`, [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
    const d = doc.rows[0];
    if (d.employee_id !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const fp = path.join(__dirname, '../..', d.file_path);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    await db.query(`DELETE FROM employee_documents WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getPrevEmployment = async (req, res) => {
  try { await ensureTables();
    const empId = req.params.employee_id || req.user.id;
    if (parseInt(empId) !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const r = await db.query(`SELECT * FROM employee_previous_employment WHERE employee_id=$1 ORDER BY from_date DESC NULLS LAST`, [empId]);
    res.json({ success: true, data: r.rows });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.upsertPrevEmployment = async (req, res) => {
  try { await ensureTables();
    const isHR = ['hr','admin','super_admin'].includes(req.user.role);
    const empId = isHR && req.body.employee_id ? parseInt(req.body.employee_id) : req.user.id;
    const { id, company_name, company_address, city, state, from_date, to_date, designation,
            job_type, prev_manager_name, prev_manager_phone, prev_manager_email,
            prev_hr_name, prev_hr_phone, prev_hr_email, pf_number,
            reason_for_leaving, is_overseas, is_relevant } = req.body;
    if (!company_name) return res.status(400).json({ success: false, message: 'Company name required' });
    if (id) {
      await db.query(`UPDATE employee_previous_employment SET
        company_name=$1,company_address=$2,city=$3,state=$4,from_date=$5,to_date=$6,
        designation=$7,job_type=$8,prev_manager_name=$9,prev_manager_phone=$10,prev_manager_email=$11,
        prev_hr_name=$12,prev_hr_phone=$13,prev_hr_email=$14,pf_number=$15,
        reason_for_leaving=$16,is_overseas=$17,is_relevant=$18 WHERE id=$19 AND employee_id=$20`,
        [company_name,company_address,city,state,from_date||null,to_date||null,
         designation,job_type||'Full Time',prev_manager_name,prev_manager_phone,prev_manager_email,
         prev_hr_name,prev_hr_phone,prev_hr_email,pf_number,reason_for_leaving,
         is_overseas||false,is_relevant||false,id,empId]);
    } else {
      await db.query(`INSERT INTO employee_previous_employment
        (employee_id,company_name,company_address,city,state,from_date,to_date,
         designation,job_type,prev_manager_name,prev_manager_phone,prev_manager_email,
         prev_hr_name,prev_hr_phone,prev_hr_email,pf_number,reason_for_leaving,is_overseas,is_relevant,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [empId,company_name,company_address,city,state,from_date||null,to_date||null,
         designation,job_type||'Full Time',prev_manager_name,prev_manager_phone,prev_manager_email,
         prev_hr_name,prev_hr_phone,prev_hr_email,pf_number,reason_for_leaving,
         is_overseas||false,is_relevant||false,req.user.id]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.deletePrevEmployment = async (req, res) => {
  try {
    if (!['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'HR only' });
    await db.query(`DELETE FROM employee_previous_employment WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.getQualifications = async (req, res) => {
  try { await ensureTables();
    const empId = req.params.employee_id || req.user.id;
    if (parseInt(empId) !== req.user.id && !['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Access denied' });
    const r = await db.query(`SELECT * FROM employee_qualifications WHERE employee_id=$1 ORDER BY passing_year DESC NULLS LAST`, [empId]);
    res.json({ success: true, data: r.rows });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.upsertQualification = async (req, res) => {
  try { await ensureTables();
    const isHR = ['hr','admin','super_admin'].includes(req.user.role);
    const empId = isHR && req.body.employee_id ? parseInt(req.body.employee_id) : req.user.id;
    const { id, qualification, degree, specialization, institute_name, board_university,
            mode_of_education, state_location, grade_percentage, passing_month, passing_year,
            academic_achievements, remarks, is_highest } = req.body;
    if (!qualification || !institute_name) return res.status(400).json({ success: false, message: 'Required fields missing' });
    if (id) {
      await db.query(`UPDATE employee_qualifications SET
        qualification=$1,degree=$2,specialization=$3,institute_name=$4,board_university=$5,
        mode_of_education=$6,state_location=$7,grade_percentage=$8,passing_month=$9,passing_year=$10,
        academic_achievements=$11,remarks=$12,is_highest=$13 WHERE id=$14 AND employee_id=$15`,
        [qualification,degree,specialization,institute_name,board_university,
         mode_of_education,state_location,grade_percentage,passing_month||null,passing_year||null,
         academic_achievements,remarks,is_highest||false,id,empId]);
    } else {
      await db.query(`INSERT INTO employee_qualifications
        (employee_id,qualification,degree,specialization,institute_name,board_university,
         mode_of_education,state_location,grade_percentage,passing_month,passing_year,
         academic_achievements,remarks,is_highest,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [empId,qualification,degree,specialization,institute_name,board_university,
         mode_of_education,state_location,grade_percentage,passing_month||null,passing_year||null,
         academic_achievements,remarks,is_highest||false,req.user.id]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteQualification = async (req, res) => {
  try {
    if (!['hr','admin','super_admin'].includes(req.user.role))
      return res.status(403).json({ success: false, message: 'HR only' });
    await db.query(`DELETE FROM employee_qualifications WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
};
