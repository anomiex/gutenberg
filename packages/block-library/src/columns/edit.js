/**
 * External dependencies
 */
import classnames from 'classnames';
import { get, times } from 'lodash';

/**
 * WordPress dependencies
 */
import { __ } from '@wordpress/i18n';
import {
	BaseControl,
	Notice,
	PanelBody,
	__experimentalRadio as Radio,
	__experimentalRadioGroup as RadioGroup,
	ToggleControl,
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
import {
	createBlock,
	createBlocksFromInnerBlocksTemplate,
	store as blocksStore,
} from '@wordpress/blocks';
import { useEffect, useState } from '@wordpress/element';

/**
 * Internal dependencies
 */
import {
	hasExplicitPercentColumnWidths,
	getMappedColumnWidths,
	getRedistributedColumnWidths,
	toWidthPrecision,
} from './utils';

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

function ColumnsEdit( { attributes, setAttributes, clientId } ) {
	const { isStackedOnMobile, verticalAlignment } = attributes;

	const { getBlockOrder, getBlocks } = useSelect(
		( select ) => select( blockEditorStore ),
		[ clientId ]
	);

	const innerBlockClientIds = getBlockOrder( clientId );
	const [ count, setCount ] = useState();
	const vacantIndexes = innerBlockClientIds.reduce(
		( vacants, id, index ) =>
			getBlockOrder( id ).length ? vacants : [ ...vacants, index ],
		[]
	);

	// Keeps count synced with actual inner block length. An approach that
	// could avoid this not even have count as state would be nice.
	useEffect( () => {
		if ( count !== innerBlockClientIds.length ) {
			setCount( innerBlockClientIds.length );
		}
	}, [ innerBlockClientIds.length, count ] );

	const { updateBlockAttributes, replaceInnerBlocks } = useDispatch(
		blockEditorStore
	);

	/**
	 * Update all child Column blocks with a new vertical alignment setting
	 * based on whatever alignment is passed in. This allows change to parent
	 * to overide anything set on a individual column basis.
	 *
	 * @param {string} nextAlignment the vertical alignment setting
	 */
	const updateAlignment = ( nextAlignment ) => {
		// Update own alignment.
		setAttributes( { verticalAlignment: nextAlignment } );

		// Update all child Column Blocks to match
		innerBlockClientIds.forEach( ( innerBlockClientId ) => {
			updateBlockAttributes( innerBlockClientId, {
				verticalAligment: nextAlignment,
			} );
		} );
	};

	/**
	 * Updates the column count, including necessary revisions to child Column
	 * blocks to grant required or redistribute available space.
	 *
	 * @param {number} previousColumns Previous column count.
	 * @param {number} newColumns      New column count.
	 */
	const updateColumns = ( previousColumns, newColumns ) => {
		let innerBlocks = getBlocks( clientId );
		const hasExplicitWidths = hasExplicitPercentColumnWidths( innerBlocks );

		// Redistribute available width for existing inner blocks.
		const isAddingColumn = newColumns > previousColumns;

		if ( isAddingColumn && hasExplicitWidths ) {
			// If adding a new column, assign width to the new column equal to
			// as if it were `1 / columns` of the total available space.
			const newColumnWidth = toWidthPrecision( 100 / newColumns );

			// Redistribute in consideration of pending block insertion as
			// constraining the available working width.
			const widths = getRedistributedColumnWidths(
				innerBlocks,
				100 - newColumnWidth
			);

			innerBlocks = [
				...getMappedColumnWidths( innerBlocks, widths ),
				...times( newColumns - previousColumns, () => {
					return createBlock( 'core/column', {
						width: `${ newColumnWidth }%`,
					} );
				} ),
			];
		} else if ( isAddingColumn ) {
			innerBlocks = [
				...innerBlocks,
				...times( newColumns - previousColumns, () => {
					return createBlock( 'core/column' );
				} ),
			];
		} else {
			// Removes vacant columns
			const difference = previousColumns - newColumns;
			const indexesToRemove = vacantIndexes.slice( -difference );
			innerBlocks = innerBlocks.filter(
				( item, index ) => ! indexesToRemove.includes( index )
			);

			if ( hasExplicitWidths ) {
				// Redistribute as if block is already removed.
				const widths = getRedistributedColumnWidths( innerBlocks, 100 );

				innerBlocks = getMappedColumnWidths( innerBlocks, widths );
			}
		}

		replaceInnerBlocks( clientId, innerBlocks );
		setCount( innerBlocks.length );
	};

	const columnsMin = Math.max( 1, count - vacantIndexes.length );
	const columnsMax = 6;
	const columnsRadioList = [];
	for ( let i = 1; i <= columnsMax; i++ ) {
		const disabled = i < columnsMin;
		columnsRadioList.push(
			<Radio key={ i } { ...{ disabled, value: i } }>
				{ i }
			</Radio>
		);
	}
	if ( count > columnsMax ) {
		columnsRadioList.push(
			<Radio key={ count } value={ count }>
				{ count }
			</Radio>
		);
	}

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

	return (
		<>
			<BlockControls>
				<BlockVerticalAlignmentToolbar
					onChange={ updateAlignment }
					value={ verticalAlignment }
				/>
			</BlockControls>
			<InspectorControls>
				<PanelBody title={ __( 'Columns' ) }>
					<BaseControl>
						<RadioGroup
							label={ __( 'Quantity' ) }
							onChange={ ( value ) => {
								// Somehow keyboard input is has this fire
								// twice so this avoids the extra one
								if ( value !== count ) {
									updateColumns( count, value );
								}
							} }
							checked={ count }
						>
							{ columnsRadioList }
						</RadioGroup>
					</BaseControl>
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
			</InspectorControls>
			<div { ...innerBlocksProps } />
		</>
	);
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

const MetaColumnsEdit = ( props ) => {
	const { clientId } = props;
	const hasInnerBlocks = useSelect(
		( select ) =>
			select( blockEditorStore ).getBlocks( clientId ).length > 0,
		[ clientId ]
	);
	const Component = hasInnerBlocks ? ColumnsEdit : Placeholder;

	return <Component { ...props } />;
};

export default MetaColumnsEdit;
