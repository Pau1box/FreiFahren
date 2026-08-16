import './Line.css'

import React from 'react'
import { useLineColor } from 'src/hooks/useLineColor'

const Line: React.FC<{ line: string }> = ({ line }) => {
    const getLineColor = useLineColor()

    if (line === '') {
        return null
    }
    return (
        <span className="line" style={{ backgroundColor: getLineColor(line) }} data-select-value={line}>
            <strong>{line}</strong>
        </span>
    )
}

export { Line }
