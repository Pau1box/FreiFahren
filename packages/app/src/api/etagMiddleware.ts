import AsyncStorage from '@react-native-async-storage/async-storage'
import { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { isNil } from 'lodash'

interface ETagCacheConfig {
    endpoints: (string | RegExp)[]
    storageKeyPrefix?: string
    shouldCache?: (config: InternalAxiosRequestConfig) => boolean
    onCacheHit?: (url: string) => void
    onCacheUpdate?: (url: string) => void
}

export const createETagMiddleware = (params: ETagCacheConfig) => {
    const { endpoints, storageKeyPrefix = 'etag_', shouldCache = () => true, onCacheHit, onCacheUpdate } = params

    const shouldCacheEndpoint = (url: string): boolean => {
        return endpoints.some((endpoint) => {
            if (typeof endpoint === 'string') {
                return url.includes(endpoint)
            }
            return endpoint.test(url)
        })
    }

    /**
     * The same path serves a different city per `?network=`, and axios keeps query parameters out of
     * `config.url`. Without the network in the key, Hamburg would be answered from Berlin's cached body.
     */
    const getStorageKeys = (url: string, network: string = '') => {
        const safeUrl = `${url}_network_${network}`.replace(/[^a-zA-Z0-9]/g, '')

        return {
            etagKey: `${storageKeyPrefix}etag_${safeUrl}`,
            dataKey: `${storageKeyPrefix}data_${safeUrl}`,
        }
    }

    const getRequestNetwork = (config: InternalAxiosRequestConfig): string => {
        const network: unknown = config.params?.network

        return typeof network === 'string' ? network : ''
    }

    const clearCache = async (url: string, network?: string): Promise<void> => {
        const { etagKey, dataKey } = getStorageKeys(url, network)

        await Promise.all([AsyncStorage.removeItem(etagKey), AsyncStorage.removeItem(dataKey)])
    }

    const clearAllCaches = async (): Promise<void> => {
        try {
            const keys = await AsyncStorage.getAllKeys()

            const etagKeys = keys.filter((key) => key.startsWith(storageKeyPrefix))

            if (etagKeys.length > 0) {
                await AsyncStorage.multiRemove(etagKeys)
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Failed to clear ETag caches:', error)
        }
    }

    const requestInterceptor = async (config: InternalAxiosRequestConfig): Promise<InternalAxiosRequestConfig> => {
        const { url } = config

        if (url === undefined || !shouldCacheEndpoint(url) || !shouldCache(config)) {
            return config
        }

        try {
            const { etagKey, dataKey } = getStorageKeys(url, getRequestNetwork(config))
            const [etag, cachedData] = await Promise.all([AsyncStorage.getItem(etagKey), AsyncStorage.getItem(dataKey)])

            /*
             An ETag is only worth sending while the body it stands for is still there. A 304 has no
             body, so claiming a copy we no longer hold would answer nothing and leave the parse with
             an empty response.
            */
            if (etag !== null && etag !== '' && cachedData !== null) {
                // eslint-disable-next-line no-param-reassign
                config.headers['If-None-Match'] = etag
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Error retrieving ETag from cache:', error)
        }

        return config
    }

    const responseInterceptor = async (response: AxiosResponse): Promise<AxiosResponse> => {
        const { url } = response.config

        if (url === undefined || !shouldCacheEndpoint(url) || !shouldCache(response.config)) {
            return response
        }

        const { etagKey, dataKey } = getStorageKeys(url, getRequestNetwork(response.config))

        if (response.status === 304) {
            try {
                const cachedData = await AsyncStorage.getItem(dataKey)

                if (cachedData !== null) {
                    // eslint-disable-next-line no-param-reassign
                    response.data = JSON.parse(cachedData)
                    onCacheHit?.(url)
                } else {
                    // The body the ETag stood for is gone, so the ETag would keep earning empty 304s
                    // forever. Dropping it lets the next request come back with data.
                    await AsyncStorage.removeItem(etagKey)
                }
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Error retrieving cached data:', error)
            }

            return response
        }

        if (
            response.status >= 200 &&
            response.status < 300 &&
            !isNil(response.data) &&
            response.headers.etag !== undefined
        ) {
            try {
                // The body is written before the ETag so that an ETag never outlives the body it
                // stands for. A failed write leaves neither behind, so the next request asks in full.
                await AsyncStorage.setItem(dataKey, JSON.stringify(response.data))
                await AsyncStorage.setItem(etagKey, response.headers.etag)
                onCacheUpdate?.(url)
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Error caching response data:', error)
                await clearCache(url, getRequestNetwork(response.config)).catch(() => {})
            }
        }

        return response
    }

    const applyMiddleware = (axiosInstance: AxiosInstance): void => {
        axiosInstance.interceptors.request.use(requestInterceptor)
        axiosInstance.interceptors.response.use(responseInterceptor)
    }

    return {
        requestInterceptor,
        responseInterceptor,
        applyMiddleware,
        clearCache,
        clearAllCaches,
    }
}
