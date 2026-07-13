import { writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function walkSync(dir, filelist = []) {
  try {
    readdirSync(dir).forEach(file => {
      const dirFile = join(dir, file);
      if (statSync(dirFile).isDirectory()) {
        filelist = walkSync(dirFile, filelist);
      } else {
        filelist.push(dirFile);
      }
    });
  } catch (e) {}
  return filelist;
}

const dirPath = join('c:', 'Users', 'lxy', 'Desktop', 'work', 'woohoo', 'src');
const files = walkSync(dirPath).filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));

let count = 0;
files.forEach(f => {
  if (f.includes('AppContext.tsx') || f.includes('store')) return;
  
  let content = readFileSync(f, 'utf8');
  if (content.includes('useAppContext')) {
    content = content.replace(/const\s+\{([^}]+)\}\s*=\s*useAppContext\(\)/g, (match, keys) => {
        const trimmedKeys = keys.split(',').map(s => s.trim()).filter(s => s);
        const mapping = trimmedKeys.map(k => {
           const rawKey = k.split(':')[0].trim();
           return rawKey + ': state.' + rawKey;
        }).join(', ');
        return 'const { ' + keys + ' } = useAppStore(useShallow(state => ({' + mapping + '})))';
    });
    
    content = content.replace(/useAppContext\(\)/g, 'useAppStore()');
    
    content = content.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)context\/AppContext['"];/g, (match, imports, prefix) => {
       const parts = imports.split(',').map(s => s.trim()).filter(s => s);
       const withoutApp = parts.filter(s => s !== 'useAppContext');
       let result = "import { useAppStore } from '" + prefix + "store';\nimport { useShallow } from 'zustand/react/shallow';\n";
       if (withoutApp.length > 0) {
          result += "import { " + withoutApp.join(', ') + " } from '" + prefix + "context/AppContext';\n";
       }
       return result;
    });

    writeFileSync(f, content, 'utf8');
    count++;
  }
});
console.log('Refactored ' + count + ' files.');
