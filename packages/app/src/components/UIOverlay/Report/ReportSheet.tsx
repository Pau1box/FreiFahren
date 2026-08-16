import { MaterialCommunityIcons, Octicons } from '@expo/vector-icons'
import { BottomSheetModalMethods } from '@gorhom/bottom-sheet/lib/typescript/types'
import { useTheme } from '@shopify/restyle'
import { forwardRef, PropsWithChildren, Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutAnimation } from 'react-native'
import { ScrollView } from 'react-native-gesture-handler'

import { useSubmitReport } from '../../../api'
import { LineMode } from '../../../api/client'
import { useLines, useStations } from '../../../api/queries'
import { useAppStore } from '../../../app.store'
import { compareLineNames, useAvailableModes, useIsRingLine, useLineMode } from '../../../lines'
import { useActiveNetwork } from '../../../networks'
import { Theme } from '../../../theme'
import { track } from '../../../tracking'
import { FFButton, FFText, FFView } from '../../common/base'
import { FFCarousellSelect } from '../../common/FFCarousellSelect'
import { FFLineTag } from '../../common/FFLineTag'
import { FFScrollSheet } from '../../common/FFSheet'
import { FFSpinner } from '../../common/FFSpinner'
import { SbahnIcon } from './SbahnIcon'
import { TramIcon } from './TramIcon'
import { UbahnIcon } from './UbahnIcon'

export type ReportSheetMethods = {
    open: () => void
    close: () => void
}

// The three brand marks only exist for the modes they belong to, so the rest fall back to a generic icon.
const ModeIcon = ({ mode }: { mode: LineMode }) => {
    switch (mode) {
        case 'subway':
            return <UbahnIcon />
        case 'light_rail':
            return <SbahnIcon />
        case 'tram':
            return <TramIcon />
        case 'train':
            return <MaterialCommunityIcons name="train" size={36} color="white" />
        default:
            return <MaterialCommunityIcons name="help-circle-outline" size={36} color="white" />
    }
}

export const ReportSheet = forwardRef((_props: PropsWithChildren<{}>, ref: Ref<ReportSheetMethods>) => {
    const { t: tCommon } = useTranslation()
    const { t: tReport } = useTranslation('makeReport')
    const { mutateAsync: submitReport, isPending } = useSubmitReport()
    const { data: stations } = useStations()
    const { data: lines } = useLines()
    const sheetRef = useRef<BottomSheetModalMethods>(null)
    const theme = useTheme<Theme>()
    const updateAppStore = useAppStore((state) => state.update)
    const network = useActiveNetwork()

    const openedAt = useRef<number | null>(null)

    useImperativeHandle(ref, () => ({
        open: () => {
            sheetRef.current?.present()
            openedAt.current = Date.now()
            track({ name: 'Report Sheet Opened' })
        },
        close: () => {
            sheetRef.current?.close()
            openedAt.current = null
        },
    }))

    const [selectedMode, setSelectedMode] = useState<LineMode | null>(null)
    const [selectedLine, setSelectedLine] = useState<string | null>(null)
    const [selectedDirection, setSelectedDirection] = useState<string | null>(null)
    const [selectedStation, setSelectedStation] = useState<string | null>(null)

    const availableModes = useAvailableModes()
    const lineMode = useLineMode()
    const isRingLine = useIsRingLine()

    // Which modes exist depends on the city, so the first one the network has stands in until the
    // user picks another.
    const mode: LineMode | null = selectedMode ?? (availableModes.length > 0 ? availableModes[0] : null)

    const isValid = selectedLine !== null && selectedStation !== null

    // Line and station ids only mean something inside their network, so a switch discards the
    // selection instead of submitting one city's station under another city's name.
    useEffect(() => {
        setSelectedMode(null)
        setSelectedLine(null)
    }, [network?.id])

    useEffect(() => setSelectedLine(null), [mode])
    useEffect(() => {
        if (selectedLine !== null) {
            sheetRef.current?.expand()
        }
        setSelectedDirection(null)
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    }, [selectedLine])
    useEffect(() => setSelectedStation(null), [selectedLine])

    const lineOptions = useMemo(
        () =>
            Object.keys(lines ?? {})
                .filter((line) => lineMode(line) === mode)
                .sort(compareLineNames),
        [mode, lineMode, lines]
    )

    if (lines === undefined || stations === undefined) return null

    // A line selected before a network switch is gone from `lines` until the reset effect runs.
    const stationOptions = (selectedLine === null ? undefined : lines[selectedLine]) ?? []

    const directionOptions =
        stationOptions.length === 0 ? [] : [stationOptions[0], stationOptions[stationOptions.length - 1]]

    const isDisabled = !isValid || isPending

    const shouldShowDirection = selectedLine !== null && !isRingLine(selectedLine)

    const close = () => {
        sheetRef.current?.close()

        setSelectedMode(null)
        setSelectedLine(null)
    }

    const onSubmit = async () => {
        if (!isValid) return

        const duration = Math.floor((Date.now() - openedAt.current!) / 1000)

        const data = {
            line: selectedLine,
            stationId: selectedStation,
            directionId: selectedDirection,
        }

        track({
            name: 'Report Submitted',
            duration,
            ...data,
        })

        const newReport = await submitReport(data)

        close()

        updateAppStore({ reportToShow: newReport })
    }

    return (
        <FFScrollSheet ref={sheetRef} onDismiss={close}>
            <FFView>
                <FFText variant="header1" mb="xs" color="fg">
                    {tReport('title')}
                </FFText>
                <FFCarousellSelect
                    options={availableModes}
                    selectedOption={mode}
                    onSelect={setSelectedMode}
                    containerProps={{ py: 's', flex: 1 }}
                    renderOption={(option) => <ModeIcon mode={option} />}
                />
                <FFText variant="header2" fontWeight="bold" color="fg" mt="xs" mb="xxs">
                    {tCommon('line')}
                </FFText>
                <FFView style={{ marginHorizontal: -theme.spacing.sm }}>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ paddingHorizontal: theme.spacing.sm }}
                    >
                        <FFCarousellSelect
                            options={lineOptions}
                            selectedOption={selectedLine}
                            onSelect={setSelectedLine}
                            containerProps={{ py: 'xs', px: 'xs' }}
                            renderOption={(line) => <FFLineTag line={line} textProps={{ variant: 'header1' }} />}
                        />
                    </ScrollView>
                </FFView>
                {selectedLine !== null && shouldShowDirection && (
                    <>
                        <FFText variant="header2" fontWeight="bold" color="fg" mt="xs" mb="xxs">
                            {tCommon('direction')}
                        </FFText>
                        <FFCarousellSelect
                            vertical
                            options={directionOptions}
                            selectedOption={selectedDirection}
                            onSelect={setSelectedDirection}
                            containerProps={{
                                py: 'xs',
                                px: 'xs',
                                justifyContent: 'flex-start',
                            }}
                            renderOption={(direction, isSelected) => (
                                <FFView flexDirection="row">
                                    <FFText fontWeight={isSelected ? 'bold' : undefined}>
                                        {stations[direction]?.name ?? '?'}
                                    </FFText>
                                </FFView>
                            )}
                        />
                    </>
                )}
                {selectedLine !== null && (
                    <>
                        <FFText variant="header2" fontWeight="bold" mt="xs" mb="xxs">
                            {tCommon('station')}
                        </FFText>
                        <FFCarousellSelect
                            vertical
                            collapses
                            options={stationOptions}
                            selectedOption={selectedStation}
                            onSelect={setSelectedStation}
                            containerProps={{
                                py: 'xs',
                                px: 'xs',
                                justifyContent: 'flex-start',
                            }}
                            renderOption={(station, isSelected) => (
                                <FFView flexDirection="row" alignSelf="flex-start">
                                    <FFText fontWeight={isSelected ? 'bold' : undefined}>
                                        {stations[station]?.name ?? '?'}
                                    </FFText>
                                </FFView>
                            )}
                        />
                    </>
                )}
            </FFView>
            <FFButton
                variant="primary"
                onPress={onSubmit}
                disabled={isDisabled}
                marginTop="m"
                opacity={isDisabled ? 0.5 : 1}
            >
                {isPending ? (
                    <FFSpinner color1="white" size={24} />
                ) : (
                    <>
                        <Octicons name="report" size={24} color="white" />
                        <FFText
                            style={{
                                color: 'white',
                                fontSize: 20,
                                fontWeight: 'bold',
                                marginLeft: 10,
                            }}
                        >
                            {tReport('submit')}
                        </FFText>
                    </>
                )}
            </FFButton>
        </FFScrollSheet>
    )
})
