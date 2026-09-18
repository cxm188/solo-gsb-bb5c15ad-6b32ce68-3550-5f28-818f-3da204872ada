// 静态租约批量导入：粘贴含表头的 CSV（网段 CIDR、设备名、IPv4、MAC），
// 接入当前规划中成功分配的固定 / 自动网段与既有 hostAssignments，生成可预览、可一次性应用的合并方案。
//
// 关键不变量：
//   1. 网段 CIDR 必须唯一匹配当前「成功分配」的固定或自动网段（保留区 / 空闲区 / 失败需求不接受）；
//   2. MAC 经 normalizeMacInput 规范（小写冒号），并以规范 MAC 作为设备身份：
//      已有 MAC -> 更新名称、网段与地址；新 MAC -> 新增；
//   3. 应用前先构造「合并后的完整登记快照」（既有登记按 MAC 就地更新 + 新登记追加），
//      再在快照上统一校验地址冲突，因此两台既有设备互换地址不会因处理顺序误报；
//   4. 逐行标记新增 / 更新 / 无变化 / 冲突；缺失字段、非法字段、输入内重复 MAC、
//      网段内重复 IP、网络 / 广播 / 越界地址、与未更新登记的地址冲突都会逐行标出；
//   5. 任一冲突都禁止应用；全部通过后一次性替换整个 hostAssignments 状态。
//
// 本模块为纯函数，不修改规划、基线、既有登记与任何录入；规划变化后调用方保留原始 CSV 重新调用本模块重算预览。

import { intToIp, ipToInt, parseCidr } from './ip'
import { allocatableSegments, type AllocSegment } from './hosts'
import { normalizeMacInput } from './mac'
import type { HostAssignment, PlanResult } from './types'

/** 表头规范化后的四个必备列名（去除所有空白后比较，兼容「网段 CIDR」/「网段CIDR」等写法） */
const HEADER_CIDR = '网段CIDR'
const HEADER_NAME = '设备名'
const HEADER_IP = 'IPv4'
const HEADER_MAC = 'MAC'

/** CSV 数据行的处置状态 */
export type BulkRowStatus = 'add' | 'update' | 'unchanged' | 'conflict'

/** 一行 CSV 的预览视图 */
export interface BulkPreviewRow {
  /** 数据序号（不含表头，从 1 开始，仅统计非空白记录） */
  index: number
  rawCidr: string
  rawName: string
  rawIp: string
  rawMac: string
  /** 唯一匹配到的固定 / 自动网段；缺失或不匹配时为 null */
  segment: AllocSegment | null
  /** 修剪后的设备名（缺失时为空串） */
  name: string
  /** 解析后的地址数值（非法时为 null） */
  address: number | null
  /** 规范化后的 MAC（缺失 / 非法时为 null） */
  mac: string | null
  /** 按 MAC 匹配到的既有登记（新 MAC 为 null） */
  existing: HostAssignment | null
  status: BulkRowStatus
  /** 本行全部冲突 / 校验问题（空数组表示该行无问题） */
  errors: string[]
}

export interface BulkImportPreview {
  /** 文本框中是否存在任何非空白内容 */
  hasContent: boolean
  /** 表头问题（缺少必备列等）；存在时不解析数据行、整体不可应用 */
  headerError: string | null
  rows: BulkPreviewRow[]
  /** 存在问题的数据行数 */
  errorCount: number
  counts: { add: number; update: number; unchanged: number; conflict: number }
  /** 全部通过后才允许一次性应用 */
  canApply: boolean
}

/* ---------- 极简 RFC 4180 风格 CSV 解析（支持双引号包裹与 "" 转义、CR/LR/LF 换行、BOM） ---------- */

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  // 去掉 UTF-8 BOM（U+FEFF，Excel 粘贴常见）
  const src = text.replace(/^\uFEFF/, '')

  const pushField = () => {
    record.push(field)
    field = ''
  }
  const pushRecord = () => {
    pushField()
    records.push(record)
    record = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\n') {
      pushRecord()
    } else if (ch === '\r') {
      pushRecord()
      if (src[i + 1] === '\n') i++
    } else {
      field += ch
    }
  }
  // 文件结尾最后一条记录（无尾换行也不丢）
  if (field !== '' || record.length > 0) pushRecord()
  return records
}

/** 整条记录每个单元格（去首尾空白后）均为空：视为空白行跳过，不占数据序号 */
function isBlankRecord(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '')
}

function normalizeHeader(cell: string): string {
  return cell.trim().replace(/\s+/g, '')
}

/* ---------- 预览构造 ---------- */

/**
 * 解析 CSV 文本并在「合并后的完整登记快照」上统一校验，返回逐行预览。
 * 纯函数：不修改 csvText、assignments 与 result。
 */
export function buildBulkPreview(
  csvText: string,
  assignments: HostAssignment[],
  result: PlanResult,
): BulkImportPreview {
  const empty: BulkImportPreview = {
    hasContent: false,
    headerError: null,
    rows: [],
    errorCount: 0,
    counts: { add: 0, update: 0, unchanged: 0, conflict: 0 },
    canApply: false,
  }
  if (csvText.trim() === '') return empty

  const records = parseCsvRecords(csvText)
  const headerIdx = records.findIndex((r) => !isBlankRecord(r))
  if (headerIdx === -1) return empty

  const header = records[headerIdx]
  const colOf = new Map<string, number>()
  header.forEach((cell, i) => {
    const key = normalizeHeader(cell)
    if (key && !colOf.has(key)) colOf.set(key, i)
  })
  const missing = [HEADER_CIDR, HEADER_NAME, HEADER_IP, HEADER_MAC].filter(
    (key) => !colOf.has(key),
  )
  if (missing.length > 0) {
    return {
      ...empty,
      hasContent: true,
      headerError: `表头缺少必备列：${missing.join('、')}（需含表头行：网段 CIDR,设备名,IPv4,MAC）`,
    }
  }

  const segs = allocatableSegments(result)
  const segByCidr = new Map<string, AllocSegment>()
  for (const seg of segs) segByCidr.set(seg.cidr, seg)
  const existingByMac = new Map<string, HostAssignment>()
  for (const a of assignments) if (a.mac) existingByMac.set(a.mac, a)

  const dataRecords = records.slice(headerIdx + 1).filter((r) => !isBlankRecord(r))

  // 第一遍：逐行做字段级解析与校验，并记录输入内重复 MAC、网段内重复 IP 的首次占用
  const firstMacRow = new Map<string, number>()
  const firstIpRow = new Map<string, number>()
  const rows: BulkPreviewRow[] = dataRecords.map((cells, i) => {
    const index = i + 1
    const cell = (key: string): string => {
      const col = colOf.get(key)!
      return (cells[col] ?? '').trim()
    }
    const rawCidr = cell(HEADER_CIDR)
    const rawName = cell(HEADER_NAME)
    const rawIp = cell(HEADER_IP)
    const rawMac = cell(HEADER_MAC)
    const errors: string[] = []

    // 网段 CIDR：必填、合法规范 CIDR、唯一匹配当前固定 / 自动网段
    let segment: AllocSegment | null = null
    if (!rawCidr) {
      errors.push('缺少网段 CIDR')
    } else {
      const parsed = parseCidr(rawCidr, true)
      if ('error' in parsed) {
        errors.push(parsed.error)
      } else {
        const canonical = `${intToIp(parsed.network)}/${parsed.prefix}`
        const matched = segByCidr.get(canonical)
        if (!matched) {
          errors.push(
            `网段 ${canonical} 不匹配任何当前成功分配的固定 / 自动网段（保留区、空闲区与失败需求不可导入）`,
          )
        } else {
          segment = matched
        }
      }
    }

    // 设备名必填
    const name = rawName.trim()
    if (!name) errors.push('缺少设备名')

    // IPv4：必填且为合法地址文本（网络 / 广播 / 越界在拿到网段后判断）
    let address: number | null = null
    if (!rawIp) {
      errors.push('缺少 IPv4')
    } else {
      const addr = ipToInt(rawIp)
      if (Number.isNaN(addr)) {
        errors.push(`“${rawIp}”不是合法的 IPv4 地址`)
      } else {
        address = addr
      }
    }

    // MAC：必填并复用统一规范化（拒绝非法格式、全零、组播位）；输入内重复随后判断
    let mac: string | null = null
    if (!rawMac) {
      errors.push('缺少 MAC')
    } else {
      const macResult = normalizeMacInput(rawMac)
      if (macResult.error) {
        errors.push(macResult.error)
      } else if (macResult.mac) {
        mac = macResult.mac
      }
    }

    if (mac) {
      const first = firstMacRow.get(mac)
      if (first === undefined) {
        firstMacRow.set(mac, index)
      } else {
        errors.push(`MAC ${mac} 与输入内第 ${first} 条重复（同一 CSV 中 MAC 必须唯一）`)
      }
    }

    if (segment && address !== null) {
      const ipText = intToIp(address)
      if (address === segment.start) {
        errors.push(`${ipText} 是网段 ${segment.cidr} 的网络地址，不能分配给主机`)
      } else if (address === segment.end) {
        errors.push(`${ipText} 是网段 ${segment.cidr} 的广播地址，不能分配给主机`)
      } else if (address < segment.start || address > segment.end) {
        errors.push(
          `${ipText} 越出网段 ${segment.cidr} 的可用范围 ${segment.firstUsable} ~ ${segment.lastUsable}`,
        )
      } else {
        const key = `${segment.ownerId}#${address}`
        const first = firstIpRow.get(key)
        if (first === undefined) {
          firstIpRow.set(key, index)
        } else {
          errors.push(`IPv4 ${ipText} 与输入内第 ${first} 条在同一网段重复`)
        }
      }
    }

    const existing = mac ? (existingByMac.get(mac) ?? null) : null

    return { index, rawCidr, rawName, rawIp, rawMac, segment, name, address, mac, existing, status: 'conflict', errors }
  })

  // 第二遍：构造合并后的完整登记快照（既有登记按 MAC 就地更新 + 新 MAC 追加），
  // 在快照上检查 CSV 目标地址与「未更新登记」的冲突。整表一次性检查，与行处理顺序无关。
  const updatedById = new Map<string, HostAssignment>()
  const csvRowByUpdatedId = new Map<string, number>()
  const newAssignments: { rowIndex: number; assignment: HostAssignment }[] = []
  for (const row of rows) {
    if (row.errors.length > 0 || !row.segment || row.address === null || !row.mac || !row.name) continue
    const next: HostAssignment = row.existing
      ? {
          ...row.existing,
          ownerId: row.segment.ownerId,
          name: row.name,
          address: row.address,
          mode:
            row.existing.ownerId === row.segment.ownerId && row.existing.address === row.address
              ? row.existing.mode
              : 'manual',
          mac: row.mac,
        }
      : {
          id: '', // apply 阶段补 makeId()
          ownerId: row.segment.ownerId,
          name: row.name,
          address: row.address,
          mode: 'manual',
          mac: row.mac,
        }
    if (row.existing) {
      // 同一既有登记仅被首条（MAC 首次出现）更新；重复 MAC 行已在第一遍判为冲突
      if (!updatedById.has(row.existing.id)) {
        updatedById.set(row.existing.id, next)
        csvRowByUpdatedId.set(row.existing.id, row.index)
      }
    } else {
      newAssignments.push({ rowIndex: row.index, assignment: next })
    }
  }

  interface SnapEntry {
    assignment: HostAssignment
    rowIndex: number | null // 非 null 表示该快照项来自 CSV 行
  }
  const snapshot: SnapEntry[] = [
    ...assignments.map((a) => ({
      assignment: updatedById.get(a.id) ?? a,
      rowIndex: csvRowByUpdatedId.get(a.id) ?? null,
    })),
    ...newAssignments.map((n) => ({ assignment: n.assignment, rowIndex: n.rowIndex })),
  ]

  // 占用清单只统计「当前规划下地址位于所属网段可用范围内」的快照项；
  // 已失效的未更新登记（孤儿 / 越界等）不占地址，沿用主机面板既有语义。
  const occupants = new Map<string, SnapEntry[]>()
  for (const entry of snapshot) {
    const seg = segs.find((s) => s.ownerId === entry.assignment.ownerId)
    if (!seg) continue
    const { address } = entry.assignment
    if (address <= seg.start || address >= seg.end) continue
    const key = `${seg.ownerId}#${address}`
    const list = occupants.get(key)
    if (list) list.push(entry)
    else occupants.set(key, [entry])
  }

  for (const row of rows) {
    if (row.errors.length > 0 || !row.segment || row.address === null) continue
    const key = `${row.segment.ownerId}#${row.address}`
    const others = (occupants.get(key) ?? []).filter(
      (e) => e.rowIndex !== row.index && !(e.rowIndex === null && row.existing && e.assignment.id === row.existing.id),
    )
    // 与 CSV 内另一行的碰撞已在第一遍按「首次占用」报告，这里只补与未更新登记的冲突；
    // 未更新登记是否成立不受 CSV 行顺序影响（互换地址时双方都来自 CSV，不会误报）。
    const retained = others.find((e) => e.rowIndex === null)
    if (retained) {
      row.errors.push(
        `IPv4 ${intToIp(row.address)} 与未在本次 CSV 中更新的既有登记“${
          retained.assignment.name || '未命名设备'
        }”冲突（该地址已被占用，需在 CSV 中一并为其指定新地址或删除该地址）`,
      )
    }
  }

  // 第三遍：定状态
  let errorCount = 0
  const counts = { add: 0, update: 0, unchanged: 0, conflict: 0 }
  for (const row of rows) {
    if (row.errors.length > 0) {
      row.status = 'conflict'
      errorCount++
    } else if (row.existing) {
      const unchanged =
        row.existing.ownerId === row.segment!.ownerId &&
        row.existing.address === row.address &&
        (row.existing.name || '').trim() === row.name
      row.status = unchanged ? 'unchanged' : 'update'
    } else {
      row.status = 'add'
    }
    counts[row.status]++
  }

  return {
    hasContent: true,
    headerError: null,
    rows,
    errorCount,
    counts,
    canApply: rows.length > 0 && errorCount === 0,
  }
}

/**
 * 应用预览：一次性返回合并后的完整登记列表。
 * 既有登记按稳定 id 就地更新（保持原顺序），新 MAC 登记按 CSV 顺序追加；
 * 未被 CSV 触及的登记（含失效孤儿登记）原样保留。调用方必须在 canApply 为 true 时调用。
 */
export function applyBulkPreview(
  preview: BulkImportPreview,
  assignments: HostAssignment[],
  makeId: () => string,
): HostAssignment[] {
  if (!preview.canApply) return assignments
  const updatedById = new Map<string, HostAssignment>()
  const fresh: HostAssignment[] = []
  for (const row of preview.rows) {
    if (row.status === 'conflict' || !row.segment || row.address === null || !row.mac || !row.name) continue
    if (row.existing) {
      if (updatedById.has(row.existing.id)) continue
      updatedById.set(row.existing.id, {
        ...row.existing,
        ownerId: row.segment.ownerId,
        name: row.name,
        address: row.address,
        mode:
          row.existing.ownerId === row.segment.ownerId && row.existing.address === row.address
            ? row.existing.mode
            : 'manual',
        mac: row.mac,
      })
    } else {
      fresh.push({
        id: makeId(),
        ownerId: row.segment.ownerId,
        name: row.name,
        address: row.address,
        mode: 'manual',
        mac: row.mac,
      })
    }
  }
  return [...assignments.map((a) => updatedById.get(a.id) ?? a), ...fresh]
}
