const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['text/csv', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];
  // Accept CSV files that might come through as octet-stream
  const ext = file.originalname?.split('.').pop()?.toLowerCase();
  if (allowed.includes(file.mimetype) || ext === 'csv' || ext === 'pdf') {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`), false);
  }
};

const limits = { fileSize: 10 * 1024 * 1024 }; // 10MB

exports.uploadSingle = multer({ storage, fileFilter, limits }).single('file');
exports.uploadMultiple = multer({ storage, fileFilter, limits }).array('files', 5);
exports.uploadNone = multer({ storage }).none();
