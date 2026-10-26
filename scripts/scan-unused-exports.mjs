import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
const files=[]
async function walk(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())await walk(p);else if(/\.(js|jsx|mjs)$/.test(p))files.push(p)}}
await walk('src');for(const f of await fs.readdir('.'))if(/^test.*\.mjs$/.test(f))files.push(f)
const texts=new Map(await Promise.all(files.map(async f=>[f,await fs.readFile(f,'utf8')]))),report=[]
for(const [file,text] of texts){if(!file.startsWith('src/'))continue
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,file.endsWith('.jsx')?ts.ScriptKind.JSX:ts.ScriptKind.JS)
 for(const stmt of ast.statements){if(!stmt.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)||stmt.modifiers.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword))continue
 const ids=ts.isVariableStatement(stmt)?stmt.declarationList.declarations.map(d=>d.name).filter(ts.isIdentifier):stmt.name?[stmt.name]:[]
 for(const id of ids){const pattern=new RegExp(`\\b${id.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'g');let references=0;for(const body of texts.values())references+=[...body.matchAll(pattern)].length
 if(references===1)report.push({file,line:ast.getLineAndCharacterOfPosition(id.getStart(ast)).line+1,export:id.text,decision:'conserver API publique : suppression non requise pour corriger les bugs'})
 }
 }
}
await fs.writeFile('audit-evidence/unused-exports.json',JSON.stringify({method:'AST TypeScript + inventaire des références lexicales src/tests. Inventaire prudent, pas preuve de couverture runtime.',candidates:report},null,2));console.log('Exports publics sans référence interne:',report.length,'(conservés pour compatibilité)')
