import { reasoning } from "@/lib/ai/reasoning"
import { UIMessage } from "ai"
import React from "react"
import ToolUsage from "./tool-status"
import Reasoning from "./reasoning-status"

export default function MessageStatus({ message }: { message: UIMessage }) {
    const [showReasoning, setShowReasoning] = React.useState(false)
    const currentReasoning = reasoning(message)

    return <>
        {currentReasoning && <Reasoning currentReasoning={currentReasoning} showReasoning={showReasoning} setShowReasoning={setShowReasoning} />}
        <ToolUsage m={message} />
    </>
}