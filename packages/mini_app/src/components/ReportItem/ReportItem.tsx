import React from 'react'
import { Report } from '../../utils/types'
import { useLineColor } from '../../hooks/useLineColors'
import './ReportItem.css'

interface ReportItemProps {
    report: Report
}

export const ReportItem: React.FC<ReportItemProps> = ({ report }) => {
    const lineColor = useLineColor()

    const formatTime = (timestamp: string) => {
        const date = new Date(timestamp)
        return date.toLocaleTimeString('de-DE', { 
            hour: '2-digit', 
            minute: '2-digit' 
        })
    }

    return (
        <div className="report-item">
            <div className="report-item-header">
                <div className="report-item-time">
                    {formatTime(report.timestamp)}
                </div>
                {report.line && (
                    <div 
                        className="report-item-line"
                        style={{ backgroundColor: lineColor(report.line) }}
                    >
                        {report.line}
                    </div>
                )}
            </div>
            <div className="report-item-station">
                {report.station.name}
            </div>
            {report.direction && (
                <div className="report-item-direction">
                    → {report.direction.name}
                </div>
            )}
            {report.message && (
                <div className="report-item-message">
                    {report.message}
                </div>
            )}
        </div>
    )
} 