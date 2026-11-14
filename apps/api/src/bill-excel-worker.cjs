const { parentPort, workerData } = require('node:worker_threads');
const XLSX = require('@e965/xlsx');
try {
  const book = XLSX.read(Buffer.from(workerData), { type: 'buffer', cellDates: false, cellNF: true, cellFormula: true, cellHTML: false, bookVBA: false, sheetRows: 1002, dateNF: 'yyyy-mm-dd' });
  if (book.SheetNames.length > 10) throw new Error('Use a workbook with at most 10 sheets.');
  const grids = [];
  let count = 0;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
    if (range.e.r > 1000 || range.e.c > 59) throw new Error('Each sheet must fit within 1,000 rows and 60 columns.');
    const rows = [], formulas = {};
    for (let r = 0; r <= range.e.r; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({r,c})];
        let value = '';
        if (cell) {
          if (cell.f) formulas[`${r}:${c}`] = String(cell.f).slice(0,2000);
          // Excel stores calendar dates as serial numbers, without a time zone.
          // Decode directly so server time zones cannot shift the due day.
          if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
            const date = XLSX.SSF.parse_date_code(cell.v, { date1904: !!book.Workbook?.WBProps?.date1904 });
            if (date) value = `${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
          } else if (cell.v != null) value = String(cell.v);
          if (value.length > 4000) throw new Error('A spreadsheet cell is longer than 4,000 characters.');
          if (value && ++count > 20000) throw new Error('The workbook has more than 20,000 filled cells.');
        }
        row.push(value);
      }
      rows.push(row);
    }
    grids.push({name, rows, formulas});
  }
  parentPort.postMessage({grids});
} catch (error) { parentPort.postMessage({error: error.message || 'This workbook could not be read.'}); }
