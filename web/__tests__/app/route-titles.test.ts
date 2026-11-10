/**
 * Every app route names its tab. The root layout's template turns a route's
 * short name into "owlette - <name>"; a route that sets none shows the landing
 * page's title, so a tab of /swoop or /demo read like the home page.
 *
 * A client page cannot export `metadata`, so the name may sit in the page or in
 * any layout between it and the root.
 */
import fs from 'fs';
import path from 'path';

const APP = path.join(__dirname, '..', '..', 'app');
const NAMES_ITS_TAB = /export (const metadata\b[\s\S]*?\btitle\b|(async )?function generateMetadata\b)/;

function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'api' && dir === APP ? [] : pages(full);
    return entry.name === 'page.tsx' ? [full] : [];
  });
}

function namesItsTab(file: string): boolean {
  return fs.existsSync(file) && NAMES_ITS_TAB.test(fs.readFileSync(file, 'utf8'));
}

function titled(page: string): boolean {
  for (let dir = path.dirname(page); dir !== APP; dir = path.dirname(dir)) {
    if (namesItsTab(path.join(dir, 'page.tsx')) || namesItsTab(path.join(dir, 'layout.tsx'))) return true;
  }
  return false;
}

it('names the tab of every route but the landing page', () => {
  const untitled = pages(APP)
    // the landing page is the one the root title is written for
    .filter((page) => page !== path.join(APP, 'page.tsx'))
    .filter((page) => !titled(page))
    .map((page) => path.relative(APP, page).split(path.sep).join('/'));

  expect(untitled).toEqual([]);
});
