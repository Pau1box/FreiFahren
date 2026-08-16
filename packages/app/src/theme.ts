import { createTheme } from '@shopify/restyle'

const palette = {
    bg2: '#131218',
    bg: '#232528',
    danger: '#B52F2F',
    fg: '#F0F0F0',
    success: '#C9F299',
    safetyGreen: '#4D8E46',
    selected: '#3478f6',
    blue: '#68f9ff',
    green: '#4D8E46',
    primary: '#3478f6',
    whiteish: '#E9E7E7',
    border: '#181818',
    darkGrey: '#4A4A4A',
    darkText: '#8A8A8A',
    // Line colours come from GET /v0/lines/metadata. This is what a line without one is drawn in.
    lineNeutral: '#6f6f6f',
}

export const theme = createTheme({
    colors: palette,
    /* spacing: {
        xxxs: 1,
        xxs: 2,
        xs: 4,
        s: 8,
        m: 16,
        l: 24,
        xl: 40,
    }, */
    spacing: {
        xxxs: 4,
        xxs: 8,
        xs: 12,
        s: 16,
        xsm: 18,
        sm: 22,
        m: 32,
        l: 36,
        xl: 40,
    },
    /* fontVariants: {
        bold: { fontFamily: 'Funnel Sans Bold' },
        boldItalic: { fontFamily: 'Funnel Sans Bold Italic' },
        italic: { fontFamily: 'Funnel Sans Italic' },
        extraBold: { fontFamily: 'Funnel Sans ExtraBold' },
        extraBoldItalic: { fontFamily: 'Funnel SansExtra Bold Italic' },
        lightItalic: { fontFamily: 'Funnel Sans Light Italic' },
        medium: { fontFamily: 'Funnel Sans Medium' },
        mediumItalic: { fontFamily: 'Funnel Sans Medium Italic' },
        regular: { fontFamily: 'Funnel Sans' },
        semiBold: { fontFamily: 'Funnel Sans SemiBold' },
    }, */
    textVariants: {
        header1: {
            fontFamily: 'Funnel Sans Bold',
            fontSize: 26,
            lineHeight: 32,
        },
        header2: {
            fontFamily: 'Funnel Sans Bold',
            fontSize: 22,
            lineHeight: 28,
        },
        header3: {
            fontFamily: 'Funnel Sans Bold',
            fontSize: 20,
            lineHeight: 24,
        },
        body: {
            fontSize: 16,
            lineHeight: 24,
        },
        small: {
            fontSize: 12,
            lineHeight: 16,
            color: 'darkText',
        },
        tiny: {
            fontSize: 10,
        },
        large: {
            fontSize: 24,
            lineHeight: 32,
        },
        label: {
            fontSize: 16,
            lineHeight: 20,
            fontFamily: 'Funnel Sans SemiBold',
        },
        labelBold: {
            fontSize: 16,
            lineHeight: 20,
            fontFamily: 'Funnel Sans Bold',
        },
        labelSmall: {
            fontSize: 12,
            lineHeight: 16,
            fontFamily: 'Funnel Sans SemiBold',
        },
        labelLarge: {
            fontSize: 20,
            lineHeight: 24,
            fontFamily: 'Funnel Sans SemiBold',
        },
        defaults: {
            fontSize: 16,
            lineHeight: 22,
            fontFamily: 'Funnel Sans Regular',
            color: 'fg',
        },
    },
    textInputVariants: {
        defaults: {
            color: 'fg',
            fontSize: 16,
            padding: 0,
        },
        search: {
            backgroundColor: 'darkGrey',
            borderRadius: 'm',
            paddingVertical: 'xs',
            paddingHorizontal: 's',
        },
    },
    borderRadii: {
        s: 4,
        m: 16,
        l: 25,
        xl: 75,
        full: 9999,
    },
    zIndices: {
        under: -1,
        body: 0,
        overlay: 1,
    },
    positions: undefined,
    buttonVariants: {
        defaults: {
            backgroundColor: 'bg',
            borderColor: 'border',
            paddingVertical: 'xs',
            paddingHorizontal: 's',
            borderWidth: 2,
            borderRadius: 'full',
            opacity: 1,
            alignItems: 'center',
            justifyContent: 'center',
        },
        primary: {
            backgroundColor: 'primary',
        },
        secondary: {
            backgroundColor: 'bg',
        },
        square: {
            borderRadius: 'm',
            paddingHorizontal: 'xs',
            paddingVertical: 'xs',
        },
        selector: {},
    },
})

export type Theme = typeof theme
