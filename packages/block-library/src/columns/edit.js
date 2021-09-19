/**
 * External dependencies
 */
import classnames from 'classnames';
import { get } from 'lodash';

/**
 * WordPress dependencies
 */
import { __ } from '@wordpress/i18n';
import {
	Notice,
	PanelBody,
	ToggleControl,
	__experimentalToggleGroupControl as ToggleGroupControl,
	__experimentalToggleGroupControlOption as ToggleGroupControlOption,
} from '@wordpress/components';
import {
	InspectorControls,
	__experimentalUseInnerBlocksProps as useInnerBlocksProps,
	BlockControls,
	BlockVerticalAlignmentToolbar,
	__experimentalBlockVariationPicker,
	useBlockProps,
	store as blockEditorStore,
} from '@wordpress/block-editor';
import { useDispatch, useSelect } from '@wordpress/data';
import { useCallback, useEffect, useState } from '@wordpress/element';
import {
	createBlocksFromInnerBlocksTemplate,
	store as blocksStore,
} from '@wordpress/blocks';

/**
 * Internal dependencies
 */
import { getRevisedColumns, getVacantIndexes } from './utils';

/**
 * Allowed blocks constant is passed to InnerBlocks precisely as specified here.
 * The contents of the array should never change.
 * The array should contain the name of each block that is allowed.
 * In columns block, the only block we allow is 'core/column'.
 *
 * @constant
 * @type {string[]}
 */
const ALLOWED_BLOCKS = [ 'core/column' ];

function ColumnsEditInnards( {
	attributes,
	setAttributes,
	// From ColumnsEditWrapper
	count,
	updateAlignment,
	reviseColumns,
	vacantIndexes,
} ) {
	const { isStackedOnMobile, verticalAlignment } = attributes;

	const classes = classnames( {
		[ `are-vertically-aligned-${ verticalAlignment }` ]: verticalAlignment,
		[ `is-not-stacked-on-mobile` ]: ! isStackedOnMobile,
	} );

	const blockProps = useBlockProps( {
		className: classes,
	} );
	const innerBlocksProps = useInnerBlocksProps( blockProps, {
		allowedBlocks: ALLOWED_BLOCKS,
		orientation: 'horizontal',
		renderAppender: false,
	} );

	const layoutPanelProps = {
		count,
		isStackedOnMobile,
		reviseColumns,
		setAttributes,
		vacantIndexes,
	};

	return (
		<>
			<BlockControls>
				<BlockVerticalAlignmentToolbar
					onChange={ updateAlignment }
					value={ verticalAlignment }
				/>
			</BlockControls>
			<InspectorControls>
				<ColumnsLayoutPanel { ...layoutPanelProps } />
			</InspectorControls>
			<div { ...innerBlocksProps } />
		</>
	);
}

function ColumnsLayoutPanel( {
	count,
	isStackedOnMobile,
	reviseColumns,
	setAttributes,
	vacantIndexes,
} ) {
	const countMin = Math.max( 1, count - vacantIndexes.length );
	const countMax = 6;
	const countOptionList = [];
	for ( let i = 1; i <= countMax; i++ ) {
		const disabled = i < countMin;
		const itemProps = { disabled, value: i, label: i, key: i };
		countOptionList.push( <ToggleGroupControlOption { ...itemProps } /> );
	}
	if ( count > countMax ) {
		const itemProps = { value: count, label: count, key: count };
		countOptionList.push( <ToggleGroupControlOption { ...itemProps } /> );
	}
	return (
		<PanelBody title={ __( 'Layout' ) }>
			<ToggleGroupControl
				label={ __( 'Quantity' ) }
				onChange={ reviseColumns }
				value={ count }
			>
				{ countOptionList }
			</ToggleGroupControl>
			{ count > 6 && (
				<Notice status="warning" isDismissible={ false }>
					{ __(
						'This column count exceeds the recommended amount and may cause visual breakage.'
					) }
				</Notice>
			) }
			<ToggleControl
				label={ __( 'Stack on mobile' ) }
				checked={ isStackedOnMobile }
				onChange={ () =>
					setAttributes( {
						isStackedOnMobile: ! isStackedOnMobile,
					} )
				}
			/>
		</PanelBody>
	);
}

function ColumnsEditWrapper( props ) {
	const { clientId, setAttributes } = props;
	const { getBlockOrder, getBlocks, initialBlocks } = useSelect(
		( select ) => {
			const store = select( blockEditorStore );
			return {
				getBlockOrder: store.getBlockOrder,
				getBlocks: store.getBlocks,
				initialBlocks: store.getBlocks( clientId ),
			};
		},
		[ clientId ]
	);

	const [ { count, vacantIndexes }, setColumnStats ] = useState( {
		vacantIndexes: getVacantIndexes( initialBlocks ),
		count: initialBlocks.length,
	} );

	const innerBlockClientIds = getBlockOrder( clientId );
	// Updates state from external changes to inner blocks such as reordering,
	// insertion, and deletion.
	useEffect( () => {
		const blocks = getBlocks( clientId );
		setColumnStats( {
			vacantIndexes: getVacantIndexes( blocks ),
			count: blocks.length,
		} );
	}, [ clientId, ...innerBlockClientIds ] );

	const { updateBlockAttributes, replaceInnerBlocks } = useDispatch(
		blockEditorStore
	);
	/**
	 * Update all child Column blocks with a new vertical alignment setting
	 * based on whatever alignment is passed in. This allows change to parent
	 * to overide anything set on a individual column basis.
	 *
	 * @param {string} verticalAlignment the vertical alignment setting
	 */
	const updateAlignment = ( verticalAlignment ) => {
		// Update own alignment.
		setAttributes( { verticalAlignment } );

		// Update all child Column Blocks to match
		innerBlockClientIds.forEach( ( innerBlockClientId ) => {
			updateBlockAttributes( innerBlockClientId, {
				verticalAlignment,
			} );
		} );
	};

	const reviseColumns = useCallback(
		( nextCount ) => {
			const current = getBlocks( clientId );
			const revised = getRevisedColumns( current, nextCount );
			replaceInnerBlocks( clientId, revised );
			setColumnStats( {
				vacantIndexes: getVacantIndexes( revised ),
				count: revised.length,
			} );
		},
		[ clientId ]
	);

	const propsOut = {
		...props,
		count,
		updateAlignment,
		reviseColumns,
		vacantIndexes,
	};

	return <ColumnsEditInnards { ...propsOut } />;
}

function Placeholder( { clientId, name, setAttributes } ) {
	const { blockType, defaultVariation, variations } = useSelect(
		( select ) => {
			const {
				getBlockVariations,
				getBlockType,
				getDefaultBlockVariation,
			} = select( blocksStore );

			return {
				blockType: getBlockType( name ),
				defaultVariation: getDefaultBlockVariation( name, 'block' ),
				variations: getBlockVariations( name, 'block' ),
			};
		},
		[ name ]
	);
	const { replaceInnerBlocks } = useDispatch( blockEditorStore );
	const blockProps = useBlockProps();

	return (
		<div { ...blockProps }>
			<__experimentalBlockVariationPicker
				icon={ get( blockType, [ 'icon', 'src' ] ) }
				label={ get( blockType, [ 'title' ] ) }
				variations={ variations }
				onSelect={ ( nextVariation = defaultVariation ) => {
					if ( nextVariation.attributes ) {
						setAttributes( nextVariation.attributes );
					}
					if ( nextVariation.innerBlocks ) {
						replaceInnerBlocks(
							clientId,
							createBlocksFromInnerBlocksTemplate(
								nextVariation.innerBlocks
							),
							true
						);
					}
				} }
				allowSkip
			/>
		</div>
	);
}

const ColumnsEdit = ( props ) => {
	const { clientId } = props;
	const hasInnerBlocks = useSelect(
		( select ) =>
			select( blockEditorStore ).getBlocks( clientId ).length > 0,
		[ clientId ]
	);
	const Component = hasInnerBlocks ? ColumnsEditWrapper : Placeholder;

	return <Component { ...props } />;
};

export default ColumnsEdit;
