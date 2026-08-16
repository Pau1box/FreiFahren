import Geolocation from '@react-native-community/geolocation'
import { useEffect, useState } from 'react'

import { Coordinates } from './api/client'

type DeviceLocation =
    | { status: 'pending' }
    | { status: 'resolved'; coordinates: Coordinates }
    | { status: 'unavailable' }

/**
 * The device position, asked for once. It stops being `pending` whether or not the user grants the
 * permission, because callers wait for it before falling back and must not wait forever.
 */
export const useDeviceLocation = (): DeviceLocation => {
    const [location, setLocation] = useState<DeviceLocation>({ status: 'pending' })

    useEffect(() => {
        let isMounted = true

        const resolve = (next: DeviceLocation) => {
            if (isMounted) setLocation(next)
        }

        Geolocation.requestAuthorization(
            () =>
                Geolocation.getCurrentPosition(
                    ({ coords }) =>
                        resolve({
                            status: 'resolved',
                            coordinates: { latitude: coords.latitude, longitude: coords.longitude },
                        }),
                    () => resolve({ status: 'unavailable' }),
                    { timeout: 5000, maximumAge: 60 * 1000 }
                ),
            () => resolve({ status: 'unavailable' })
        )

        // A permission dialog the user never answers would otherwise leave the app without a network.
        const deadline = setTimeout(() => resolve({ status: 'unavailable' }), 5000)

        return () => {
            isMounted = false
            clearTimeout(deadline)
        }
    }, [])

    return location
}

export const containsCoordinates = (
    bounds: { southWest: Coordinates; northEast: Coordinates },
    { latitude, longitude }: Coordinates
): boolean =>
    latitude >= bounds.southWest.latitude &&
    latitude <= bounds.northEast.latitude &&
    longitude >= bounds.southWest.longitude &&
    longitude <= bounds.northEast.longitude
