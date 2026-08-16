import sharp from 'sharp'
import { type Inspector, type LineColors } from './models'

function estimateTextWidth(text: string, fontSize: number): number {
    return text.length * fontSize * 0.6
}

/*
 The colours used to be a table of Berlin's lines in this file. They come from
 `GET /v0/lines/metadata` of the network the bot posts for, so the same bot can post for any city
 and a colour change in the data does not need a release here.
*/
// A neutral grey rather than white for a line the metadata does not carry: the label on top of the
// badge is white, so a white badge made the line name invisible instead of merely uncoloured.
const UNKNOWN_LINE_COLOR = '#4a4a4a'

function getLineColor(line: string, lineColors: LineColors): string {
    return lineColors[line]?.color ?? UNKNOWN_LINE_COLOR
}

// Station and direction names go into an SVG document. They come from our own data, but an
// ampersand or an angle bracket in a name would make the document unparsable and take the whole
// story down with it.
function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

function createInspectorSvg(inspector: Inspector, index: number, lineColors: LineColors): string {
    const yOffset = 275 + index * 100
    const stationName = escapeXml(inspector.station.name)
    const stationWidth = estimateTextWidth(inspector.station.name, 40)
    let lineX = stationWidth + 120
    let directionX = lineX

    let svg = `
        <g transform="translate(0, ${yOffset})">
            <circle cx="70" cy="0" r="8" fill="white" />
            <text x="100" y="10" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="white">${stationName}</text>
    `

    if (inspector.line) {
        const lineColor = getLineColor(inspector.line, lineColors)
        const lineWidth = estimateTextWidth(inspector.line, 40)
        const lineBgWidth = lineWidth + 20
        const lineBgHeight = 50
        svg += `
            <rect x="${lineX}" y="-30" width="${lineBgWidth}" height="${lineBgHeight}" rx="8" ry="8" fill="${lineColor}" />
            <text x="${
                lineX + lineBgWidth / 2
            }" y="10" font-family="Raleway" font-size="40" font-weight="bold" fill="white" text-anchor="middle">${
            escapeXml(inspector.line)
        }</text>
        `
        directionX = lineX + lineBgWidth + 40
    }

    if (inspector.direction && inspector.direction.name) {
        svg += `<text x="${directionX}" y="10" font-family="Arial, sans-serif" font-size="40" fill="white">${escapeXml(inspector.direction.name)}</text>`
    }

    svg += `</g>`
    return svg
}

function createSvgContent(width: number, height: number, inspectorSvgs: string): string {
    return `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#232323"/>
            <text x="70" y="190" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="white">Aktuelle Meldungen</text>
            ${inspectorSvgs}
            <text x="70" y="${
                height - 60
            }" font-family="Arial, sans-serif" font-size="40" fill="white">Mehr Infos auf <tspan text-decoration="underline">app.freifahren.org</tspan></text>
        </svg>
    `
}

export async function createImage(inspectors: Inspector[], lineColors: LineColors): Promise<Buffer> {
    const width = 1080
    const height = 1920

    const inspectorSvgs = inspectors.map((inspector, index) => createInspectorSvg(inspector, index, lineColors)).join('')

    const svg = createSvgContent(width, height, inspectorSvgs)

    return sharp(Buffer.from(svg)).png().toBuffer()
}
