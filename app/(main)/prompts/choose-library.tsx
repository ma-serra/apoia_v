'use client'

import { maiusculasEMinusculas } from "@/lib/utils/utils";
import { faCheck, faClose, faEdit, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react"
import TableRecords from '@/components/table-records'
import { IALibrary } from "@/lib/db/mysql-types";
import { Button } from "react-bootstrap";

const canonicalLibrary = (libraryIds: string[]) => libraryIds.sort((a, b) => a.localeCompare(b)).join(',')

function ChooseLibraryForm({ allDocuments, selectedDocuments, onSave, onClose, readyToStartAI }: {
    allDocuments: IALibrary[],
    selectedDocuments: IALibrary[],
    onSave: (documentIds: string[]) => void,
    onClose: () => void,
    readyToStartAI: boolean
}) {
    const originalDocumentIds: string[] = selectedDocuments.map(d => d.id.toString())
    const [selectedIds, setSelectedIds] = useState(originalDocumentIds)
    const [canonicalOriginalDocuments, setCanonicalOriginalDocuments] = useState(canonicalLibrary(originalDocumentIds))

    const onSelectedIdsChanged = (ids: string[]) => {
        if (canonicalLibrary(ids) !== canonicalLibrary(selectedIds))
            setSelectedIds(ids)
    }

    const alteredDocuments = canonicalLibrary(selectedIds) !== canonicalOriginalDocuments

    return <div className="mt-4 mb-4 h-print">
        <div className="alert alert-info pt-0">
            <div className="row">
                <div className="col-12">
                    <TableRecords records={allDocuments} spec="ChooseLibrary" options={{}} pageSize={10} selectedIds={selectedIds} onSelectdIdsChanged={onSelectedIdsChanged}>
                        <div className="col col-auto mb-0">
                            {alteredDocuments
                                ? <Button onClick={() => onSave(alteredDocuments ? selectedIds : [])} variant="primary" disabled={selectedIds.length === 0}>{readyToStartAI ? <><FontAwesomeIcon icon={faRotateRight} className="me-2" />Salvar Alterações e Refazer</> : <><FontAwesomeIcon icon={faCheck} className="me-1" />OK</>}</Button>
                                : <Button onClick={() => onClose()} variant="secondary"><FontAwesomeIcon icon={faClose} className="me-1" />Fechar</Button>
                            }
                        </div>
                    </TableRecords>
                </div>
            </div>
        </div>
    </div>
}

export const ChooseLibraryLoading = () => {
    return <div className="placeholder-glow">
        <div className="row justify-content-center">
            <div className="col-4"><div className="placeholder w-100"></div></div>
        </div>
    </div>
}

export default function ChooseLibrary({ allDocuments, selectedDocuments, onSave, onStartEditing, onEndEditing, readyToStartAI, baselineDefaultIds }: {
    allDocuments: IALibrary[],
    selectedDocuments: IALibrary[],
    onSave: (documentIds: string[]) => void,
    onStartEditing: () => void,
    onEndEditing: () => void,
    readyToStartAI: boolean,
    baselineDefaultIds: string[]
}) {
    const pathname = usePathname();
    const router = useRouter();
    const currentSearchParams = useSearchParams()
    const [editing, setEditing] = useState(false)

    const LIBRARY_PARAM = 'library' // stores hyphen-separated 1-based indices (1..N) in original allDocuments order

    // Helpers to convert between IDs and 1-based numbers (index in allDocuments)
    const idsToNumbers = (ids: string[]): number[] => {
        const indexById = new Map(allDocuments.map((d, idx) => [d.id.toString(), idx + 1]))
        const nums = ids.map(id => indexById.get(id)).filter((n): n is number => typeof n === 'number')
        // sort and unique
        const uniq = Array.from(new Set(nums))
        uniq.sort((a, b) => a - b)
        return uniq
    }

    const canonicalNumbers = (numbers: number[]) => Array.from(new Set(numbers.filter(n => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b).join('-')

    const replaceLibraryParam = (numbersOrNull: number[] | null) => {
        // Build new query string preserving other params
        const params = new URLSearchParams(currentSearchParams.toString())
        if (numbersOrNull && numbersOrNull.length > 0) {
            const value = canonicalNumbers(numbersOrNull)
            if (params.get(LIBRARY_PARAM) !== value) {
                params.set(LIBRARY_PARAM, value)
            }
        } else {
            if (params.has(LIBRARY_PARAM)) params.delete(LIBRARY_PARAM)
        }
        const qs = params.toString()
        const url = qs ? `${pathname}?${qs}` : pathname
        router.replace(url, { scroll: false })
    }

    const onSaveLocal = (documentIds: string[]) => {
        setEditing(false)
        onSave(documentIds)
        // If documentIds is empty, it signals "no change" (keep default selection)
        if (!documentIds || documentIds.length === 0) {
            replaceLibraryParam(null)
        } else {
            // User explicitly changed selection -> set query-string with document numbers
            const nums = idsToNumbers(documentIds)
            replaceLibraryParam(nums)
        }
        onEndEditing()
    }

    // Baseline of automatically selected documents (default) comes from parent
    const baselineDefaultIdsRef = useRef<string[] | null>(baselineDefaultIds || null)
    useEffect(() => { baselineDefaultIdsRef.current = baselineDefaultIds || null }, [baselineDefaultIds])

    const onClose = () => {
        setEditing(false)
        // Clear param only if the current selection equals the automatic baseline; otherwise, preserve existing 'library'
        try {
            const baselineIds = baselineDefaultIdsRef.current || []
            const currentIds = (selectedDocuments || []).map(d => d.id.toString())
            const isDefaultNow = canonicalLibrary(currentIds) === canonicalLibrary(baselineIds)
            if (isDefaultNow) replaceLibraryParam(null)
        } catch (_) {
            // In case of any inconsistency, avoid clearing to preserve user's selection
        }
        onEndEditing()
    }

    // Initial selection from URL moved to ProcessContents to avoid race conditions

    if (!editing) {
        const l = selectedDocuments?.map(d => maiusculasEMinusculas(d.title)) || []
        let s = `Biblioteca: `
        if (l.length === 0)
            s += 'Nenhum documento selecionado'
        else if (l.length === 1) {
            s += l[0]
        } else if (l.length === 2) {
            const last = l.pop()
            s += `${l.join(', ')} e ${last}`
        } else {
            s += l[0] + ' + ' + (l.length - 1)
        }
        return <p className="text-body-tertiary text-center h-print mb-0">{s} - <span onClick={() => { setEditing(true); onStartEditing() }} className="text-primary" style={{ cursor: 'pointer' }}><FontAwesomeIcon icon={faEdit} /> Alterar</span></p>
    }
    return <ChooseLibraryForm onSave={onSaveLocal} onClose={onClose} allDocuments={allDocuments} selectedDocuments={selectedDocuments} readyToStartAI={readyToStartAI} />
}
