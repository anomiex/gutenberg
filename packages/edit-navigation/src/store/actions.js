/**
 * External dependencies
 */
import { zip, difference } from 'lodash';

/**
 * WordPress dependencies
 */
import { __, sprintf } from '@wordpress/i18n';
import { store as noticesStore } from '@wordpress/notices';
import { store as coreDataStore } from '@wordpress/core-data';

/**
 * Internal dependencies
 */
import { STORE_NAME } from './constants';
import { addRecordIdToBlock, getRecordIdFromBlock } from './utils';
import { blockToMenuItem, menuItemToBlockAttributes } from './transform';

/**
 * Returns an action object used to select menu.
 *
 * @param {number} menuId The menu ID.
 * @return {Object} Action object.
 */
export function setSelectedMenuId( menuId ) {
	return {
		type: 'SET_SELECTED_MENU_ID',
		menuId,
	};
}

/**
 * Converts all the blocks into menu items and submits a batch request to save everything at once.
 *
 * @param {Object} post A navigation post to process
 * @return {Function} An action creator
 */
export const saveNavigationPost = ( post ) => async ( {
	registry,
	dispatch,
} ) => {
	const lock = await registry
		.dispatch( coreDataStore )
		.__unstableAcquireStoreLock( STORE_NAME, [ 'savingMenu' ], {
			exclusive: true,
		} );
	try {
		const menuId = post.meta.menuId;
		await dispatch( saveEditedMenu( menuId ) );
		const updatedBlocks = await dispatch(
			batchSaveMenuItems( post.blocks[ 0 ], menuId )
		);

		// Clear "stub" navigation post edits to avoid a false "dirty" state.
		registry
			.dispatch( coreDataStore )
			.receiveEntityRecords( 'root', 'postType', post, undefined );

		const updatedPost = {
			...post,
			blocks: [ updatedBlocks ],
		};
		registry
			.dispatch( coreDataStore )
			.receiveEntityRecords( 'root', 'postType', updatedPost, undefined );

		registry
			.dispatch( noticesStore )
			.createSuccessNotice( __( 'Navigation saved.' ), {
				type: 'snackbar',
			} );
	} catch ( saveError ) {
		const errorMessage = saveError
			? sprintf(
					/* translators: %s: The text of an error message (potentially untranslated). */
					__( "Unable to save: '%s'" ),
					saveError.message
			  )
			: __( 'Unable to save: An error ocurred.' );
		registry.dispatch( noticesStore ).createErrorNotice( errorMessage, {
			type: 'snackbar',
		} );
	} finally {
		registry.dispatch( coreDataStore ).__unstableReleaseStoreLock( lock );
	}
};

const saveEditedMenu = ( menuId ) => async ( { registry } ) => {
	await registry
		.dispatch( coreDataStore )
		.saveEditedEntityRecord( 'root', 'menu', menuId );

	const error = registry
		.select( coreDataStore )
		.getLastEntitySaveError( 'root', 'menu', menuId );

	if ( error ) {
		throw new Error( error.message );
	}
};

const batchSaveMenuItems = ( navigationBlock, menuId ) => async ( {
	dispatch,
	registry,
} ) => {
	// Make sure all the existing menu items are available before proceeding
	const oldMenuItems = await registry
		.resolveSelect( coreDataStore )
		.getMenuItems( { menus: menuId, per_page: -1 } );

	// Insert placeholders for new menu items to have an ID to work with.
	// We need that in case these new items have any children. If so,
	// we need to provide a parent id that we don't have yet.
	const navBlockWithRecordIds = await dispatch(
		batchInsertPlaceholderMenuItems( navigationBlock )
	);

	// Update menu items. This is separate from deleting, because there
	// are no consistency guarantees and we don't want to delete something
	// that was a parent node before another node takes it place.
	const navBlockAfterUpdates = await dispatch(
		batchUpdateMenuItems( navBlockWithRecordIds, menuId )
	);

	// Delete menu items
	const deletedIds = difference(
		oldMenuItems.map( ( { id } ) => id ),
		blocksTreeToList( navBlockAfterUpdates ).map( getRecordIdFromBlock )
	);
	await dispatch( batchDeleteMenuItems( deletedIds ) );

	return navBlockAfterUpdates;
};

/**
 * Creates a menu item for every block that doesn't have an associated menuItem.
 * Requests POST /wp/v2/menu-items once for every menu item created.
 *
 * @param {Object} navigationBlock Blocks to create menu items for.
 * @return {Function} An action creator
 */
const batchInsertPlaceholderMenuItems = ( navigationBlock ) => async ( {
	registry,
} ) => {
	const blocksWithoutRecordId = blocksTreeToList( navigationBlock )
		.filter( isSupportedBlock )
		.filter( ( block ) => ! getRecordIdFromBlock( block ) );

	const tasks = blocksWithoutRecordId.map( () => ( { saveEntityRecord } ) =>
		saveEntityRecord( 'root', 'menuItem', {
			title: __( 'Menu item' ),
			url: '#placeholder',
			menu_order: 1,
		} )
	);

	const results = await registry
		.dispatch( coreDataStore )
		.__experimentalBatch( tasks );

	// Return an updated navigation block with all the IDs in
	const blockToResult = new Map( zip( blocksWithoutRecordId, results ) );
	return mapBlocksTree( navigationBlock, ( block ) => {
		if ( ! blockToResult.has( block ) ) {
			return block;
		}
		return addRecordIdToBlock( block, blockToResult.get( block ).id );
	} );
};

const batchUpdateMenuItems = ( navigationBlock, menuId ) => async ( {
	registry,
	dispatch,
} ) => {
	const updatedMenuItems = blocksTreeToAnnotatedList( navigationBlock )
		// Filter out unsupported blocks
		.filter( ( { block } ) => isSupportedBlock( block ) )
		// Transform the blocks into menu items
		.map( ( { block, parentBlock, childIndex } ) =>
			blockToMenuItem(
				block,
				registry
					.select( coreDataStore )
					.getMenuItem( getRecordIdFromBlock( block ) ),
				getRecordIdFromBlock( parentBlock ),
				childIndex,
				menuId
			)
		)
		// Filter out menu items without any edits
		.filter( ( menuItem ) =>
			dispatch( applyEdits( menuItem.id, menuItem ) )
		);

	// Map the edited menu items to batch tasks
	const tasks = updatedMenuItems.map(
		( menuItem ) => ( { saveEditedEntityRecord } ) =>
			saveEditedEntityRecord( 'root', 'menuItem', menuItem.id )
	);

	await registry.dispatch( coreDataStore ).__experimentalBatch( tasks );

	// Throw on failure. @TODO failures should be thrown in core-data
	updatedMenuItems.forEach( ( menuItem ) => {
		const failure = registry
			.select( coreDataStore )
			.getLastEntitySaveError( 'root', 'menuItem', menuItem.id );
		if ( failure ) {
			throw new Error( failure.message );
		}
	} );

	// Return an updated navigation block reflecting the changes persisted in the batch update.
	return mapBlocksTree( navigationBlock, ( block ) => {
		if ( ! isSupportedBlock( block ) ) {
			return block;
		}
		const updatedMenuItem = registry
			.select( coreDataStore )
			.getMenuItem( getRecordIdFromBlock( block ) );

		return addRecordIdToBlock(
			{
				...block,
				attributes: menuItemToBlockAttributes( updatedMenuItem ),
			},
			updatedMenuItem.id
		);
	} );
};

const isSupportedBlock = ( { name } ) =>
	[ 'core/navigation-link', 'core/navigation-submenu' ].includes( name );

const applyEdits = ( id, edits ) => ( { registry } ) => {
	// Update an existing entity record.
	registry
		.dispatch( coreDataStore )
		.editEntityRecord( 'root', 'menuItem', id, edits, {
			undoIgnore: true,
		} );

	return registry
		.select( coreDataStore )
		.hasEditsForEntityRecord( 'root', 'menuItem', id );
};

const batchDeleteMenuItems = ( deletedIds ) => async ( { registry } ) => {
	const deleteBatch = deletedIds.map(
		( id ) => async ( { deleteEntityRecord } ) => {
			const success = await deleteEntityRecord( 'root', 'menuItem', id, {
				force: true,
			} );
			// @TODO failures should be thrown in core-data
			if ( ! success ) {
				throw new Error( id );
			}
			return success;
		}
	);

	return await registry
		.dispatch( coreDataStore )
		.__experimentalBatch( deleteBatch );
};

/**
 * Turns a recursive list of blocks into a flat list of blocks.
 *
 * @param {Object} parentBlock A parent block to flatten
 * @return {Object} A flat list of blocks, annotated by their index and parent ID, consisting
 * 							    of all the input blocks and all the inner blocks in the tree.
 */
function blocksTreeToAnnotatedList( parentBlock ) {
	return ( parentBlock.innerBlocks || [] ).flatMap( ( innerBlock, index ) =>
		[ { block: innerBlock, parentBlock, childIndex: index } ].concat(
			blocksTreeToAnnotatedList( innerBlock )
		)
	);
}

function blocksTreeToList( parentBlock ) {
	return blocksTreeToAnnotatedList( parentBlock ).map(
		( { block } ) => block
	);
}

function mapBlocksTree( block, callback, parentBlock = null, idx = 0 ) {
	return {
		...callback( block, parentBlock, idx ),
		innerBlocks: ( block.innerBlocks || [] ).map( ( innerBlock, index ) =>
			mapBlocksTree( innerBlock, callback, block, index )
		),
	};
}

/**
 * Returns an action object used to open/close the inserter.
 *
 * @param {boolean|Object} value                Whether the inserter should be
 *                                              opened (true) or closed (false).
 *                                              To specify an insertion point,
 *                                              use an object.
 * @param {string}         value.rootClientId   The root client ID to insert at.
 * @param {number}         value.insertionIndex The index to insert at.
 *
 * @return {Object} Action object.
 */
export function setIsInserterOpened( value ) {
	return {
		type: 'SET_IS_INSERTER_OPENED',
		value,
	};
}
