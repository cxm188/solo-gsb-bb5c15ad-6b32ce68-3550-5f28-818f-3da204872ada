import { useMemo, useState } from 'react'
import { applyBulkPreview, buildBulkPreview, type BulkRowStatus } from '../lib/bulkImport'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  csvText: string
  onCsvChange: (text: string) => void
  onAssignmentsChange: (next: HostAssignment[]) => void
  makeId: () => string
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

const STATUS_LABEL: Record<BulkRowStatus, string> = {
  add: '新增',
  update: '更新',
  unchanged: '无变化',
  conflict: '冲突',
}

const SAMPLE_CSV = `网段 CIDR,设备名,IPv4,MAC
192.168.10.16/30,网关,192.168.10.17,aa:bb:cc:dd:ee:ff
192.168.10.128/25,办公电脑-01,192.168.10.130,00-11-22-33-44-55`

/** 静态租约批量导入面板：粘贴 CSV -> 合并快照统一校验 -> 一次性替换主机登记 */
export default function BulkImportPanel({
  result,
  assignments,
  csvText,
  onCsvChange,
  onAssignmentsChange,
  makeId,
}: Props) {
  // 仅用于「应用成功」的横幅反馈；原始 CSV 与预览只随输入 / 规划变化重算
  const [appliedInfo, setAppliedInfo] = useState<{ add: number; update: number; unchanged: number } | null>(null)

  const invalid = result.inputErrors.length > 0
  const paused = invalid
  const preview = useMemo(
    () => (paused ? null : buildBulkPreview(csvText, assignments, result)),
    [paused, csvText, assignments, result],
  )

  function handleApply() {
    if (!preview || !preview.canApply) return
    const next = applyBulkPreview(preview, assignments, makeId)
    onAssignmentsChange(next)
    setAppliedInfo({
      add: preview.counts.add,
      update: preview.counts.update,
      unchanged: preview.counts.unchanged,
    })
    onCsvChange('')
  }

  const counts = preview?.counts
  const hasText = csvText.trim() !== ''

  return (
    <div className="panel bulk-panel">
      <div className="header-row">
        <h2 style={{ marginBottom: 0 }}>⑦ 静态租约批量导入</h2>
        {preview && preview.hasContent && !preview.headerError && (
          <div className="bulk-summary-meta">
            共 <strong>{preview.rows.length}</strong> 行 ·
            <span className="bulk-count add"> 新增 {counts!.add}</span> ·
            <span className="bulk-count update"> 更新 {counts!.update}</span> ·
            <span className="bulk-count unchanged"> 无变化 {counts!.unchanged}</span>
            {counts!.conflict > 0 && <span className="bulk-count conflict"> · 冲突 {counts!.conflict}</span>}
          </div>
        )}
      </div>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        粘贴<strong>含表头</strong>的 CSV（<code className="mono opt121-inline-code">网段 CIDR,设备名,IPv4,MAC</code>
        ）。网段 CIDR 必须唯一匹配当前<strong>成功分配</strong>的固定 / 自动网段；MAC 自动规范为小写冒号并作为
        <strong>设备身份</strong>——已有 MAC 更新名称、网段和地址，新 MAC 新增。应用前系统会构造
        <strong>合并后的完整登记快照统一校验</strong>（两台既有设备互换地址不会因处理顺序误报），逐行标记新增 /
        更新 / 无变化 / 冲突；<strong>任一冲突时禁止应用</strong>，全部通过后一次性替换「⑥ 主机地址分配」状态。
        规划变化后原始 CSV 保留并实时重算预览。
      </p>

      {paused && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），批量导入已暂停；CSV 原文已保留，修正后自动重新生成预览。
        </div>
      )}

      <div className="bulk-toolbar btn-row">
        <button
          type="button"
          onClick={() => {
            onCsvChange(SAMPLE_CSV)
            setAppliedInfo(null)
          }}
        >
          填入示例
        </button>
        <button type="button" onClick={() => onCsvChange('')} disabled={!hasText}>
          清空 CSV
        </button>
        <span className="opt121-toolbar-hint">
          支持双引号包裹含逗号的字段与 <code className="mono">""</code> 转义；空白行自动跳过
        </span>
      </div>

      <textarea
        className="bulk-textarea mono"
        rows={8}
        spellCheck={false}
        placeholder={SAMPLE_CSV}
        value={csvText}
        onChange={(e) => {
          onCsvChange(e.target.value)
          setAppliedInfo(null)
        }}
      />

      {appliedInfo && (
        <div className="bulk-applied-note">
          ✓ 已一次性应用：新增 {appliedInfo.add} 台、更新 {appliedInfo.update} 台、无变化{' '}
          {appliedInfo.unchanged} 台；主机地址分配、dnsmasq 静态租约等已联动刷新。
        </div>
      )}

      {preview && preview.headerError && (
        <div className="opt121-error-box">
          <strong>{preview.headerError}</strong>
        </div>
      )}

      {preview && !preview.headerError && preview.rows.length > 0 && (
        <>
          <div className="table-scroll bulk-table-scroll">
            <table className="host-table bulk-table">
              <thead>
                <tr>
                  <th className="bulk-idx">#</th>
                  <th>状态</th>
                  <th>网段 CIDR</th>
                  <th className="host-device-name">设备名</th>
                  <th className="host-addr">IPv4</th>
                  <th className="host-mac-head">MAC（规范化）</th>
                  <th className="bulk-detail">校验明细</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.index} className={row.status === 'conflict' ? 'host-invalid-row' : ''}>
                    <td className="mono bulk-idx">{row.index}</td>
                    <td>
                      <span className={`bulk-status ${row.status}`}>{STATUS_LABEL[row.status]}</span>
                    </td>
                    <td className="mono">
                      {row.segment ? (
                        <>
                          <span className={`badge ${row.segment.kind}`}>{KIND_LABEL[row.segment.kind]}</span>{' '}
                          {row.segment.cidr}
                        </>
                      ) : (
                        <span className={row.rawCidr ? 'host-addr-bad' : ''}>{row.rawCidr || '—'}</span>
                      )}
                    </td>
                    <td className="host-device-name">{row.name || row.rawName || <span className="host-mac-none">—</span>}</td>
                    <td className="mono host-addr">
                      <span className={row.address === null || row.errors.length > 0 ? 'host-addr-bad' : ''}>
                        {row.rawIp || '—'}
                      </span>
                    </td>
                    <td className="mono host-mac-cell">{row.mac ?? (row.rawMac || <span className="host-mac-none">—</span>)}</td>
                    <td className="bulk-detail">
                      {row.errors.length > 0 ? (
                        <ul className="opt121-row-errors bulk-row-errors">
                          {row.errors.map((m, j) => (
                            <li key={j}>{m}</li>
                          ))}
                        </ul>
                      ) : row.status === 'add' ? (
                        <span className="bulk-ok-text">新 MAC，将新增登记</span>
                      ) : row.status === 'update' ? (
                        <span className="bulk-ok-text">
                          匹配既有设备“{row.existing?.name || '未命名设备'}”
                          {describeChange(row.existing!, row)}
                        </span>
                      ) : (
                        <span className="bulk-ok-text">名称、网段与地址均未变化</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bulk-apply-row">
            <button
              type="button"
              className="primary"
              onClick={handleApply}
              disabled={!preview.canApply}
              title={preview.canApply ? '一次性合并替换全部主机登记' : '存在冲突或没有可导入行，禁止应用'}
            >
              应用导入（一次性替换登记）
            </button>
            {!preview.canApply && (
              <span className="bulk-blocked-hint">
                {preview.errorCount > 0
                  ? `存在 ${preview.errorCount} 行冲突，请按「校验明细」修正后再应用`
                  : '没有可导入的数据行'}
              </span>
            )}
          </div>
        </>
      )}

      {preview && preview.hasContent && !preview.headerError && preview.rows.length === 0 && (
        <p className="summary-empty">仅有表头、没有数据行；粘贴设备记录后这里会实时显示逐行预览。</p>
      )}
    </div>
  )
}

/** 更新行相对既有登记的变化摘要（名称 / 网段 / 地址） */
function describeChange(
  existing: HostAssignment,
  row: { segment: { ownerId: string; cidr: string } | null; address: number | null; name: string },
): string {
  if (!row.segment || row.address === null) return ''
  const changes: string[] = []
  if ((existing.name || '').trim() !== row.name) changes.push('名称')
  if (existing.ownerId !== row.segment.ownerId) changes.push('网段')
  if (existing.address !== row.address) changes.push('地址')
  return changes.length > 0 ? `，将更新${changes.join('、')}` : ''
}
