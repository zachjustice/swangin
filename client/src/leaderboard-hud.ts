import type { LeaderboardEntry } from './multiplayer.ts';

export class LeaderboardHud {
  private root: HTMLDivElement;
  private table: HTMLDivElement;
  private lastFlushMs = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'padding:6px 10px',
      'background:rgba(10,20,56,0.7)',
      'color:#e6ecff',
      'font:12px ui-monospace,SFMono-Regular,Menlo,monospace',
      'line-height:1.5',
      'pointer-events:none',
      'z-index:10',
      'border-radius:8px',
      'border:1px solid rgba(180,200,255,0.25)',
      'min-width:240px',
      'user-select:none',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = [
      'display:grid',
      'grid-template-columns:24px 1fr 40px 40px 48px',
      'gap:0 6px',
      'border-bottom:1px solid rgba(180,200,255,0.15)',
      'padding-bottom:3px',
      'margin-bottom:2px',
      'color:rgba(180,200,255,0.6)',
      'font-size:10px',
    ].join(';');
    header.innerHTML =
      '<span>#</span><span>Name</span>' +
      '<span style="text-align:right">K</span>' +
      '<span style="text-align:right">D</span>' +
      '<span style="text-align:right">K/D</span>';

    this.table = document.createElement('div');
    this.root.appendChild(header);
    this.root.appendChild(this.table);
    document.body.appendChild(this.root);
  }

  update(entries: LeaderboardEntry[]): void {
    const now = performance.now();
    if (now - this.lastFlushMs < 500) return;
    this.lastFlushMs = now;
    this.flush(entries);
  }

  private flush(entries: LeaderboardEntry[]): void {
    const sorted = this.sort(entries);
    const localRank = sorted.findIndex(e => e.isLocal) + 1; // 1-based; 0 if absent
    const top10 = sorted.slice(0, 10);
    const localInTop10 = localRank >= 1 && localRank <= 10;

    let html = top10.map((e, i) => this.row(e, i + 1)).join('');

    if (!localInTop10 && localRank > 0) {
      html += '<div style="border-top:1px solid rgba(180,200,255,0.12);margin-top:2px;padding-top:2px;"></div>';
      html += this.row(sorted[localRank - 1], localRank);
    }

    this.table.innerHTML = html;
  }

  private sort(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    return [...entries].sort((a, b) => {
      const kdA = a.deaths === 0 ? (a.kills > 0 ? Infinity : 0) : a.kills / a.deaths;
      const kdB = b.deaths === 0 ? (b.kills > 0 ? Infinity : 0) : b.kills / b.deaths;
      return kdB !== kdA ? kdB - kdA : b.kills - a.kills;
    });
  }

  private row(e: LeaderboardEntry, rank: number): string {
    const name = e.name.length > 12 ? e.name.slice(0, 12) + '…' : e.name;
    const css = '#' + e.color.toString(16).padStart(6, '0');
    const bold = e.isLocal ? 'font-weight:700;' : '';
    const bg = e.isLocal ? 'background:rgba(180,200,255,0.06);border-radius:3px;' : '';
    return (
      `<div style="display:grid;grid-template-columns:24px 1fr 40px 40px 48px;gap:0 6px;align-items:center;${bg}padding:1px 0;">` +
      `<span style="color:rgba(180,200,255,0.5)">${rank}.</span>` +
      `<span style="color:${css};${bold}overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.name}">${name}</span>` +
      `<span style="text-align:right">${this.fmtN(e.kills)}</span>` +
      `<span style="text-align:right">${this.fmtN(e.deaths)}</span>` +
      `<span style="text-align:right">${this.fmtKD(e.kills, e.deaths)}</span>` +
      `</div>`
    );
  }

  private fmtN(n: number): string {
    return n < 1000 ? String(n) : (n / 1000).toFixed(1) + 'k';
  }

  private fmtKD(k: number, d: number): string {
    if (d === 0) return k > 0 ? '∞' : '0.0';
    return (k / d).toFixed(1);
  }
}
