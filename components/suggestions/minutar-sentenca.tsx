"use client"
import dynamic from 'next/dynamic'
import { ModalProps, SuggestionContext } from './context'
import { Suggestion } from './base'
import { Modal, Button, Form } from 'react-bootstrap'
import { useEffect, useState } from 'react'
import { faGavel } from '@fortawesome/free-solid-svg-icons'

export const id = 'draft-sentence'
export const label = 'Minutar sentença'

export class MinutarSentencaSuggestion extends Suggestion {
  constructor() { super(id, label, faGavel) }
  resolve(ctx: SuggestionContext) {
    return {
      type: 'modal' as const,
      key: id,
      initial: { processNumber: ctx.processNumber },
      onSubmit: (values: any, context: SuggestionContext) => {
        const numero = values?.processNumber?.trim()
        if (!numero) return
        if (numero !== context.processNumber) context.setProcessNumber(numero)
        const prompt = `Minute uma sentença para o processo ${numero}. Decisão: ${values?.decision}. Fundamentação: ${values?.fundamentacao}`
        context.sendPrompt(prompt)
      }
    }
  }
}

export const suggestion = new MinutarSentencaSuggestion()

export default function DraftSentenceModal(props: ModalProps<{ processNumber?: string, decision?: 'procedente' | 'improcedente', fundamentacao?: string }>) {
  const { show, initial, draft, onSubmit, onClose, context } = props
  const [processNumber, setProcessNumber] = useState<string>(initial?.processNumber || context.processNumber || draft?.processNumber || '')
  const [decision, setDecision] = useState<'procedente' | 'improcedente'>(draft?.decision || 'procedente')
  const [fundamentacao, setFundamentacao] = useState<string>(draft?.fundamentacao || '')

  useEffect(() => {
    if (show) {
      setProcessNumber(initial?.processNumber || context.processNumber || draft?.processNumber || '')
    }
  }, [show])

  const canSubmit = processNumber.trim().length > 0 && decision && fundamentacao.trim().length > 0

  return (
    <Modal show={show} onHide={onClose} backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title>Minutar Sentença</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label>Número do processo</Form.Label>
          <Form.Control value={processNumber} onChange={(e) => setProcessNumber(e.target.value)} />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Decisão</Form.Label>
          <Form.Select value={decision} onChange={(e) => setDecision(e.target.value as any)}>
            <option value="procedente">Procedente</option>
            <option value="improcedente">Improcedente</option>
          </Form.Select>
        </Form.Group>
        <Form.Group>
          <Form.Label>Fundamentação</Form.Label>
          <Form.Control as="textarea" rows={6} value={fundamentacao} onChange={(e) => setFundamentacao(e.target.value)} />
        </Form.Group>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={() => onSubmit({ processNumber, decision, fundamentacao })}>Gerar</Button>
      </Modal.Footer>
    </Modal>
  )
}
