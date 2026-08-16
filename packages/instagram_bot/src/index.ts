import { type Inspector, type LineColors, type Network } from './models'
import { createImage } from './image'
import { createMediaContainer, publishMedia } from './instagram'
import { getInstagramUserToken, getValidAccessToken } from './auth'

import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import fs from 'fs/promises'
import cron from 'node-cron'
import path from 'path'
import fetch from 'node-fetch'

const app = new Hono()

app.use('/images/*', serveStatic({ root: './' }))

// The network this bot posts for. One deployment serves one Instagram account, so the network is
// configuration rather than something to pick per request. Berlin keeps the previous behaviour for
// a deployment that does not set it.
const NETWORK = process.env.NETWORK ?? 'berlin'

async function fetchFromBackend<T>(path: string): Promise<T> {
    const response = await fetch(`${process.env.API_URL}${path}?network=${encodeURIComponent(NETWORK)}`)
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
    }
    return (await response.json()) as T
}

const fetchInspectorData = () => fetchFromBackend<Inspector[]>('/v0/basics/inspectors')

const fetchLineColors = () => fetchFromBackend<LineColors>('/v0/lines/metadata')

/*
 The quiet hours below are about when the followers of this account are asleep, so they are hours
 in the network's own city rather than on the server's clock. The timezone comes from
 `GET /v0/networks`, the same source the rest of the project reads it from, and falls back to UTC:
 a window an hour off is a smaller failure than posting nothing at all.
*/
async function fetchNetworkTimezone(): Promise<string> {
    try {
        const networks = await fetchFromBackend<Network[]>('/v0/networks')
        const timezone = networks.find((network) => network.id === NETWORK)?.timezone
        if (!timezone) {
            console.error(`No timezone for network ${NETWORK}, falling back to UTC`)
            return 'UTC'
        }
        return timezone
    } catch (error) {
        console.error(`Could not read the timezone of network ${NETWORK}, falling back to UTC:`, error)
        return 'UTC'
    }
}

function hourIn(timezone: string): number {
    // hourCycle h23 so that midnight is 0 rather than 24, which some locales report.
    return Number(
        new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(new Date())
    )
}

async function createAndPostStory(inspectors: Inspector[], lineColors: LineColors) {
    try {
        const imgBuffer = await createImage(inspectors, lineColors)

        // Save the image to a file
        const folderPath = './images'
        await fs.mkdir(folderPath, { recursive: true })
        const imageName = `story_${Date.now()}.jpg`
        const imagePath = path.join(folderPath, imageName)
        await fs.writeFile(imagePath, Uint8Array.from(imgBuffer))

        let count = 0
        while (!(await fetch(`${process.env.APP_URL}/images/${imageName}`)).ok && count < 10) {
            console.log('Waiting for image to be available...')
            await new Promise((resolve) => setTimeout(resolve, 1000))
            count++
        }

        // public URL of the image, as required by Instagram Graph API
        const imageUrl = `${process.env.APP_URL}/images/${imageName}`

        const accessToken = await getValidAccessToken()
        const { pageAccessToken, instagramAccountId } = await getInstagramUserToken(accessToken)

        // Create media container
        const creationId = await createMediaContainer(instagramAccountId, pageAccessToken, imageUrl)

        const mediaId = await publishMedia(instagramAccountId, pageAccessToken, creationId)
        console.log('Story posted successfully:', mediaId)
    } catch (error) {
        console.error('Error creating and posting story:', error)
    }
}

// run once initially
try {
    const [inspectors, lineColors] = await Promise.all([fetchInspectorData(), fetchLineColors()])
    await createAndPostStory(inspectors, lineColors)
} catch (error) {
    console.error('Error in hourly cron job:', error)
}

// Hourly cron job to fetch data and post story, avoiding 22:00-06:00 in the network's own city to
// not spam the followers
const FIRST_POSTING_HOUR = 6
const LAST_POSTING_HOUR = 22

cron.schedule('0 * * * *', async () => {
    try {
        const timezone = await fetchNetworkTimezone()
        const currentHour = hourIn(timezone)
        if (currentHour >= FIRST_POSTING_HOUR && currentHour < LAST_POSTING_HOUR) {
            const [inspectors, lineColors] = await Promise.all([fetchInspectorData(), fetchLineColors()])
            await createAndPostStory(inspectors, lineColors)
        } else {
            console.log(
                `Skipping story post during quiet hours (${LAST_POSTING_HOUR}:00-${FIRST_POSTING_HOUR}:00 ${timezone})`
            )
        }
    } catch (error) {
        console.error('Error in hourly cron job:', error)
    }
})

// Daily cron job to delete old images
cron.schedule('0 0 * * *', async () => {
    const directory = './images'
    const now = Date.now()
    const files = await fs.readdir(directory)

    for (const file of files) {
        const filePath = path.join(directory, file)
        const stats = await fs.stat(filePath)
        const fileAge = now - stats.mtimeMs

        // Delete files older than 7 days
        if (fileAge > 7 * 24 * 60 * 60 * 1000) {
            await fs.unlink(filePath)
        }
    }
})

export default {
    port: 8000,
    fetch: app.fetch,
}

console.log('Instagram Bot is running on port 8000')
