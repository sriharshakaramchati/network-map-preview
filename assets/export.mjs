// Quote every cell and neutralize spreadsheet formula prefixes in user-supplied values.
const cell = value => {
  let s = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
export function contactsCSV(contacts) {
  const headers=['Name','Email','Phone','Company','Role','Unit','Block','LinkedIn URL','Sources'];
  return '\ufeff'+[headers,...contacts.map(c=>[c.name,(c.emails||[]).join('; '),(c.phones||[]).join('; '),c.company,c.role,c.unit,c.block,c.profile,(c.sources||[]).join('; ')])].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
export function downloadContacts(contacts,filename='my-community.csv') {
  const url=URL.createObjectURL(new Blob([contactsCSV(contacts)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
